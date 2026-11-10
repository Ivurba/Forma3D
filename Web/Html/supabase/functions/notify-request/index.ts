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
        return jsonResponse({ error: "Email notifications are not configured on the server." }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
        return jsonResponse({ error: "The session is invalid or has expired." }, 401);
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
    if (profile?.role !== "admin") {
        return jsonResponse({ error: "Administrator access required." }, 403);
    }

    let body: { requestId?: unknown };
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "A valid JSON body is required." }, 400);
    }
    if (typeof body.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
        return jsonResponse({ error: "A valid request ID is required." }, 400);
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

    const modelName = String(modelRequest.model_name);
    const safeModelName = escapeHtml(modelName);
    const quote = modelRequest.status === "quoted" && modelRequest.quote_amount !== null
        ? new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" })
            .format(Number(modelRequest.quote_amount))
        : "";
    const note = typeof modelRequest.quote_note === "string" && modelRequest.quote_note
        ? `<p>${escapeHtml(modelRequest.quote_note)}</p>`
        : "";
    const subject = quote
        ? `Tienes un presupuesto para ${modelName}`
        : `Actualización de tu petición: ${statusLabel}`;
    const html = `<p>Hola:</p>
        <p>La petición <strong>${safeModelName}</strong> ahora está en el estado: <strong>${statusLabel}</strong>.</p>
        ${quote ? `<p>Presupuesto: <strong>${quote}</strong></p>${note}` : ""}
        <p>Entra en tu cuenta de Forma3D para consultar los detalles.</p>`;
    const text = [
        "Hola:",
        `La petición "${modelName}" ahora está en el estado: ${statusLabel}.`,
        quote ? `Presupuesto: ${quote}` : "",
        modelRequest.quote_note ?? "",
        "Entra en tu cuenta de Forma3D para consultar los detalles."
    ].filter(Boolean).join("\n\n");

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
                to: [customer.email],
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
        console.error("Email provider rejected the notification.", resendResponse.status);
        return jsonResponse({ error: "The email provider did not accept the notification." }, 502);
    }

    return jsonResponse({ sent: true });
});
