import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const statusLabels: Record<string, string> = {
    quoted: "Presupuesto enviado",
    accepted: "Presupuesto aceptado",
    in_progress: "En fabricación",
    completed: "Finalizada",
    rejected: "Presupuesto rechazado"
};
const customerResponseLabels: Record<string, string> = {
    accepted: "ha aceptado el presupuesto",
    rejected: "ha rechazado el presupuesto"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character] ?? character);
}

Deno.serve(async request => {
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed." }, 405);
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization) {
        return jsonResponse({ error: "Authentication required." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL");
    if (!supabaseUrl || !anonKey || !serviceRoleKey || !resendApiKey || !fromEmail) {
        const missingSecrets = [
            ["SUPABASE_URL", supabaseUrl],
            ["SUPABASE_ANON_KEY", anonKey],
            ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
            ["RESEND_API_KEY", resendApiKey],
            ["FROM_EMAIL", fromEmail]
        ].filter(([, value]) => !value).map(([name]) => name);
        console.error("Email notification configuration is incomplete.", missingSecrets);
        return jsonResponse({ error: `Missing Edge Function secrets: ${missingSecrets.join(", ")}.` }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
        return jsonResponse({ error: "The session is invalid or has expired." }, 401);
    }

    let body: { requestId?: unknown; event?: unknown };
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "A valid JSON body is required." }, 400);
    }
    if (typeof body.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
        return jsonResponse({ error: "A valid request ID is required." }, 400);
    }
    const event = body.event ?? "admin_update";
    if (event !== "admin_update" && event !== "customer_response") {
        return jsonResponse({ error: "A valid notification event is required." }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: profile, error: profileError } = await adminClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
    if (profileError) {
        return jsonResponse({ error: "Could not verify the account role." }, 500);
    }

    const { data: modelRequest, error: requestError } = await adminClient
        .from("requests")
        .select("user_id, model_name, status, quote_amount, quote_note")
        .eq("id", body.requestId)
        .maybeSingle();
    if (requestError) {
        return jsonResponse({ error: "Could not load the request." }, 500);
    }
    if (!modelRequest) {
        return jsonResponse({ error: "Request not found." }, 404);
    }

    let recipientEmails: string[];
    let subject: string;
    let message: string;
    let quoteDetails = "";
    if (event === "admin_update") {
        if (profile?.role !== "admin") {
            return jsonResponse({ error: "Administrator access required." }, 403);
        }
        const statusLabel = statusLabels[modelRequest.status];
        if (!statusLabel) {
            return jsonResponse({ sent: false, reason: "No customer notification is needed for this status." });
        }
        const { data: customer, error: customerError } = await adminClient
            .from("profiles")
            .select("email")
            .eq("id", modelRequest.user_id)
            .single();
        if (customerError) {
            return jsonResponse({ error: "Could not load the customer's email." }, 500);
        }
        recipientEmails = [customer.email];
        message = `La petición "${modelRequest.model_name}" ahora está en el estado: ${statusLabel}.`;

        if (modelRequest.status === "quoted" && modelRequest.quote_amount !== null) {
            const quote = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" })
                .format(Number(modelRequest.quote_amount));
            quoteDetails = `<p>Presupuesto: <strong>${quote}</strong></p>`;
            message += ` Presupuesto: ${quote}.`;
            if (typeof modelRequest.quote_note === "string" && modelRequest.quote_note) {
                quoteDetails += `<p>${escapeHtml(modelRequest.quote_note)}</p>`;
                message += ` ${modelRequest.quote_note}`;
            }
        }
        subject = modelRequest.status === "quoted"
            ? `Tienes un presupuesto para ${modelRequest.model_name}`
            : `Actualización de tu petición: ${statusLabel}`;
    } else {
        if (profile?.role !== "customer" || modelRequest.user_id !== user.id) {
            return jsonResponse({ error: "You cannot notify about this request." }, 403);
        }
        const responseLabel = customerResponseLabels[modelRequest.status];
        if (!responseLabel) {
            return jsonResponse({ error: "The request has no customer response to notify." }, 409);
        }
        const { data: administrators, error: administratorsError } = await adminClient
            .from("profiles")
            .select("email")
            .eq("role", "admin");
        if (administratorsError) {
            return jsonResponse({ error: "Could not load administrator email addresses." }, 500);
        }
        recipientEmails = [...new Set(
            administrators
                .map(administrator => administrator.email?.trim())
                .filter((email): email is string => Boolean(email))
        )];
        if (recipientEmails.length === 0) {
            return jsonResponse({ error: "No administrator email address is configured in the profiles table." }, 500);
        }
        message = `El cliente ${user.email ?? user.id} ${responseLabel} para "${modelRequest.model_name}".`;
        subject = `Cliente ${responseLabel}: ${modelRequest.model_name}`;
    }

    const html = `<p>Hola:</p><p>${escapeHtml(message)}</p>${quoteDetails}`;
    const text = `Hola:\n\n${message}`;

    let resendResponse: Response;
    try {
        resendResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: fromEmail,
                to: recipientEmails,
                subject,
                html,
                text
            })
        });
    } catch (error) {
        console.error("Email provider request failed.", error);
        return jsonResponse({ error: "The email provider could not be reached." }, 502);
    }

    if (!resendResponse.ok) {
        const providerError = await resendResponse.text();
        console.error("Email provider rejected the notification.", resendResponse.status, providerError);
        return jsonResponse({
            error: `The email provider rejected the message (HTTP ${resendResponse.status}). Check the Resend sender/domain settings.`
        }, 502);
    }

    return jsonResponse({ sent: true });
});
