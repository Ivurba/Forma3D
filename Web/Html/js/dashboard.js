import { supabase } from "./supabase.js";

const bucketName = "3d-models";
const maxFileSize = 50 * 1024 * 1024;
const allowedExtensions = new Set([
    "stl", "3mf", "obj", "fbx", "glb", "gltf",
    "step", "stp", "iges", "igs", "ply", "amf", "dae", "blend"
]);
const authPanel = document.querySelector("#auth-panel");
const dashboard = document.querySelector("#dashboard");
const authForm = document.querySelector("#auth-form");
const requestForm = document.querySelector("#request-form");
const feedback = document.querySelector("#feedback");
const modeButton = document.querySelector("#mode-button");
const authSubmit = document.querySelector("#auth-submit");
const authHeading = document.querySelector("#auth-heading");
const currentRequestList = document.querySelector("#current-request-list");
const historyRequestList = document.querySelector("#history-request-list");
const currentStatusFilter = document.querySelector("#current-status-filter");
const historyStatusFilter = document.querySelector("#history-status-filter");
const roleForm = document.querySelector("#role-form");
let authMode = "login";
let requestsChannel;
let currentRequests = [];
let currentRole = "customer";

const statusLabels = {
    pending: "Pendiente de presupuesto",
    quoted: "Presupuesto enviado",
    accepted: "Presupuesto aceptado",
    in_progress: "En fabricación",
    completed: "Finalizada",
    rejected: "Presupuesto rechazado"
};

function showMessage(message, isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle("feedback-error", isError);
    feedback.hidden = !message;
}

function getAuthErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/email rate limit exceeded/i.test(message)) {
        return "Supabase ha limitado temporalmente el envío de correos. No sigas intentando registrarte ahora. Espera a que se restablezca el límite o configura un servicio SMTP propio en Supabase > Authentication > SMTP Settings. Si ya tienes una cuenta, vuelve a «Inicia sesión».";
    }
    return `No se pudo completar el acceso: ${message}`;
}

function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function formatPrice(value) {
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR"
    }).format(Number(value));
}

function formatDate(value) {
    return new Intl.DateTimeFormat("es-ES", {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(new Date(value));
}

async function getAuthenticatedUser() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    if (!user) throw new Error("Tu sesión ha caducado. Inicia sesión de nuevo.");
    return user;
}

function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === "register";
    authHeading.textContent = registering ? "Crea tu cuenta" : "Inicia sesión";
    authSubmit.textContent = registering ? "Crear cuenta" : "Entrar";
    modeButton.textContent = registering ? "Ya tengo cuenta" : "Crear una cuenta";
    document.querySelector("#auth-intro").textContent = registering
        ? "Regístrate para solicitar presupuestos y seguir tus pedidos."
        : "Entra para enviar tu modelo 3D y consultar tus presupuestos.";
    authForm.elements.password.autocomplete = registering ? "new-password" : "current-password";
}

function setSignedOut() {
    if (requestsChannel) {
        void supabase.removeChannel(requestsChannel);
        requestsChannel = undefined;
    }
    authPanel.hidden = false;
    dashboard.hidden = true;
    showMessage("");
}

async function showDashboard(user) {
    showMessage("");
    const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, email, role")
        .eq("id", user.id)
        .single();

    if (profileError) {
        showMessage(`No se pudo cargar tu perfil: ${profileError.message}`, true);
        authPanel.hidden = false;
        dashboard.hidden = true;
        return false;
    }

    authPanel.hidden = true;
    dashboard.hidden = false;
    document.querySelector("#account-email").textContent = profile.email;
    document.querySelector("#account-email-copy").textContent = profile.email;
    document.querySelector("#dashboard-title").textContent = profile.role === "admin"
        ? "Peticiones de presupuesto"
        : "Mis peticiones";

    const customerPanel = document.querySelector("#customer-panel");
    const adminNotice = document.querySelector("#admin-notice");
    customerPanel.hidden = profile.role === "admin";
    adminNotice.hidden = profile.role !== "admin";

    if (profile.role !== "admin" && profile.role !== "customer") {
        showMessage("El perfil no tiene un rol válido. Contacta con el administrador.", true);
        return false;
    }

    const requestsLoaded = await loadRequests(profile);
    if (requestsChannel) {
        await supabase.removeChannel(requestsChannel);
    }
    const filter = profile.role === "admin" ? undefined : `user_id=eq.${profile.id}`;
    requestsChannel = supabase
        .channel(`requests-${profile.id}`)
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: "requests",
            ...(filter ? { filter } : {})
        }, () => {
            void loadRequests(profile);
        })
        .subscribe(status => {
            if (status === "CHANNEL_ERROR") {
                showMessage("No se pudo activar la actualización automática. Puedes pulsar «Actualizar» para consultar los cambios.", true);
            }
        });
    return requestsLoaded;
}

function requestCardMarkup(request, fileUrl, isAdmin) {
    const status = statusLabels[request.status] ?? request.status;
    const amount = request.quote_amount === null ? "" : `
        <p class="request-quote"><strong>Presupuesto:</strong> ${escapeHtml(formatPrice(request.quote_amount))}</p>`;
    const note = request.quote_note
        ? `<p class="request-note">${escapeHtml(request.quote_note)}</p>`
        : "";
    const customer = isAdmin
        ? `<p class="request-customer"><strong>Cliente:</strong> ${escapeHtml(request.profiles?.email ?? request.user_id)}</p>`
        : "";
    const acceptButton = !isAdmin && request.status === "quoted"
        ? `<div class="quote-actions">
                <button class="button button-accent" type="button" data-accept-quote="${escapeHtml(request.id)}">Aceptar presupuesto</button>
                <button class="button button-secondary" type="button" data-reject-quote="${escapeHtml(request.id)}">Rechazar presupuesto</button>
           </div>`
        : "";
    const quoteForm = isAdmin && request.status === "pending"
        ? `<form class="quote-form" data-quote-form="${escapeHtml(request.id)}">
                <label>Precio (€)<input name="amount" type="number" min="0.01" step="0.01" required></label>
                <label>Mensaje para el cliente<textarea name="note" rows="2" maxlength="1000"></textarea></label>
                <button class="button button-accent" type="submit">Enviar presupuesto</button>
           </form>`
        : "";
    const requestStatuses = [
        ["pending", "Pendiente de presupuesto"],
        ["quoted", "Presupuesto enviado"],
        ["accepted", "Presupuesto aceptado"],
        ["in_progress", "En fabricación"],
        ["completed", "Finalizada"],
        ["rejected", "Presupuesto rechazado"]
    ];
    const statusForm = isAdmin
        ? `<form class="status-form" data-status-form="${escapeHtml(request.id)}">
                <label>Estado de la petición
                    <select name="status">
                        ${requestStatuses.map(([value, label]) => {
                            const unavailable = ["quoted", "accepted"].includes(value) && request.quote_amount === null;
                            const selected = value === request.status ? " selected" : "";
                            const disabled = unavailable ? " disabled" : "";
                            return `<option value="${value}"${selected}${disabled}>${label}</option>`;
                        }).join("")}
                    </select>
                </label>
                <button class="button button-accent" type="submit">Guardar cambios</button>
           </form>`
        : "";

    return `<article class="request-card">
        <div class="request-card-heading">
            <div>
                <span class="request-date">${escapeHtml(formatDate(request.created_at))}</span>
                <h3>${escapeHtml(request.model_name)}</h3>
            </div>
            <span class="status-badge status-${escapeHtml(request.status)}">${escapeHtml(status)}</span>
        </div>
        ${customer}
        <p class="request-description">${escapeHtml(request.description)}</p>
        ${amount}
        ${note}
        <a class="text-link model-download" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Descargar modelo 3D ↗</a>
        ${acceptButton}
        ${quoteForm}
        ${statusForm}
    </article>`;
}

function renderRequestLists() {
    const activeStatuses = new Set(["pending", "quoted", "accepted", "in_progress"]);
    const activeRequests = currentRequests.filter(request => activeStatuses.has(request.status));
    const historyRequests = currentRequests.filter(request => request.status === "completed" || request.status === "rejected");
    renderRequestList(currentRequestList, activeRequests, currentStatusFilter.value, "No hay peticiones actuales.");
    renderRequestList(historyRequestList, historyRequests, historyStatusFilter.value, "Todavía no hay peticiones finalizadas o rechazadas.");
}

function renderRequestList(container, requests, selectedStatus, emptyMessage) {
    const filteredRequests = selectedStatus === "all"
        ? requests
        : requests.filter(request => request.status === selectedStatus);
    if (filteredRequests.length === 0) {
        container.innerHTML = `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
        return;
    }

    container.innerHTML = filteredRequests
        .map(request => requestCardMarkup(request, request.signedUrl, currentRole === "admin"))
        .join("");
    container.querySelectorAll("[data-accept-quote]").forEach(button => {
        button.addEventListener("click", () => acceptQuote(button));
    });
    container.querySelectorAll("[data-reject-quote]").forEach(button => {
        button.addEventListener("click", () => rejectQuote(button));
    });
    container.querySelectorAll("[data-quote-form]").forEach(form => {
        form.addEventListener("submit", event => sendQuote(event, form));
    });
    container.querySelectorAll("[data-status-form]").forEach(form => {
        form.addEventListener("submit", event => updateStatus(event, form));
    });
}

async function loadRequests(profile) {
    currentRequestList.innerHTML = '<p class="empty-state">Cargando peticiones…</p>';
    historyRequestList.innerHTML = '<p class="empty-state">Cargando historial…</p>';
    let query = supabase
        .from("requests")
        .select("id, user_id, model_path, model_name, description, status, quote_amount, quote_note, created_at, profiles!requests_user_id_fkey(email)")
        .order("created_at", { ascending: false });

    if (profile.role !== "admin") {
        query = query.eq("user_id", profile.id);
    }

    const { data: requests, error: requestsError } = await query;
    if (requestsError) {
        showMessage(`No se pudieron cargar las peticiones: ${requestsError.message}`, true);
        currentRequestList.replaceChildren();
        historyRequestList.replaceChildren();
        return false;
    }

    if (requests.length === 0) {
        currentRequests = [];
        currentRole = profile.role;
        renderRequestLists();
        return true;
    }

    let signedUrls;
    try {
        signedUrls = await Promise.all(requests.map(async request => {
            const { data, error } = await supabase.storage
                .from(bucketName)
                .createSignedUrl(request.model_path, 300);
            if (error) {
                throw new Error(`No se pudo preparar la descarga de "${request.model_name}": ${error.message}`);
            }
            return data.signedUrl;
        }));
    } catch (error) {
        showMessage(error.message, true);
        currentRequestList.replaceChildren();
        historyRequestList.replaceChildren();
        return false;
    }

    currentRequests = requests.map((request, index) => ({ ...request, signedUrl: signedUrls[index] }));
    currentRole = profile.role;
    renderRequestLists();
    return true;
}

currentStatusFilter.addEventListener("change", renderRequestLists);
historyStatusFilter.addEventListener("change", renderRequestLists);

roleForm.addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("");
    const button = roleForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { error } = await supabase.rpc("set_profile_role", {
            p_email: roleForm.elements.email.value.trim(),
            p_role: roleForm.elements.role.value
        });
        if (error) throw error;
        const email = roleForm.elements.email.value.trim();
        const role = roleForm.elements.role.value;
        roleForm.reset();
        showMessage(`Rol de ${email} actualizado a ${role === "admin" ? "administrador" : "cliente"}.`);
    } catch (error) {
        showMessage(`No se pudo cambiar el rol: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
});

authForm.addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("");
    authSubmit.disabled = true;
    const email = authForm.elements.email.value.trim();
    const password = authForm.elements.password.value;

    try {
        if (authMode === "register") {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: window.location.href.split("#")[0] }
            });
            if (error) throw error;

            if (data.session) {
                await showDashboard(data.user);
            } else {
                showMessage("Cuenta creada. Revisa tu correo para confirmar el registro y después inicia sesión.");
                setAuthMode("login");
                authForm.reset();
            }
        } else {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            await showDashboard(data.user);
        }
    } catch (error) {
        showMessage(getAuthErrorMessage(error), true);
    } finally {
        authSubmit.disabled = false;
    }
});

modeButton.addEventListener("click", () => {
    showMessage("");
    setAuthMode(authMode === "login" ? "register" : "login");
});

document.querySelector("#sign-out").addEventListener("click", async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
        showMessage(`No se pudo cerrar sesión: ${error.message}`, true);
        return;
    }
    setSignedOut();
});

document.querySelector("#refresh-requests").addEventListener("click", async () => {
    let user;
    try {
        user = await getAuthenticatedUser();
    } catch (error) {
        setSignedOut();
        showMessage(`No se pudo comprobar la sesión: ${error.message}`, true);
        return;
    }
    await showDashboard(user);
});

requestForm.addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("");
    const submitButton = requestForm.querySelector('button[type="submit"]');
    const file = requestForm.elements.model.files[0];
    const description = requestForm.elements.description.value.trim();

    if (!file) {
        showMessage("Selecciona el archivo del modelo 3D.", true);
        return;
    }
    const extension = file.name.split(".").pop().toLowerCase();
    if (!allowedExtensions.has(extension)) {
        showMessage("Formato no admitido. Usa STL, 3MF, OBJ, FBX, GLB, GLTF, STEP, STP, IGES, IGS, PLY, AMF, DAE o BLEND.", true);
        return;
    }
    if (file.size > maxFileSize) {
        showMessage("El archivo supera el límite de 50 MB.", true);
        return;
    }

    submitButton.disabled = true;
    let uploadedPath;
    try {
        const user = await getAuthenticatedUser();

        const requestId = crypto.randomUUID();
        const safeName = file.name.replace(/[^\w.-]/g, "_");
        uploadedPath = `${user.id}/${requestId}/${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from(bucketName)
            .upload(uploadedPath, file, { upsert: false, cacheControl: "3600" });
        if (uploadError) throw uploadError;

        const { error: insertError } = await supabase.from("requests").insert({
            id: requestId,
            user_id: user.id,
            model_path: uploadedPath,
            model_name: file.name,
            description
        });

        if (insertError) {
            const { error: cleanupError } = await supabase.storage.from(bucketName).remove([uploadedPath]);
            if (cleanupError) {
                throw new Error(`No se pudo guardar la petición: ${insertError.message}. Tampoco se pudo limpiar el archivo subido: ${cleanupError.message}`);
            }
            throw insertError;
        }

        requestForm.reset();
        const requestsLoaded = await showDashboard(user);
        if (requestsLoaded) {
            showMessage("Petición enviada. Te avisaremos aquí cuando tengamos tu presupuesto.");
        } else {
            showMessage("Petición enviada, pero no se pudo actualizar el panel. Pulsa «Actualizar» para volver a intentarlo.", true);
        }
    } catch (error) {
        showMessage(`No se pudo enviar la petición: ${error.message}`, true);
    } finally {
        submitButton.disabled = false;
    }
});

async function sendQuote(event, form) {
    event.preventDefault();
    showMessage("");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const amount = Number(form.elements.amount.value);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("Introduce un precio válido mayor que cero.");
        }
        const { error } = await supabase
            .from("requests")
            .update({
                quote_amount: amount,
                quote_note: form.elements.note.value.trim(),
                status: "quoted"
            })
            .eq("id", form.dataset.quoteForm);
        if (error) throw error;
        const user = await getAuthenticatedUser();
        if (await showDashboard(user)) {
            showMessage("Presupuesto enviado al panel del cliente.");
        }
    } catch (error) {
        showMessage(`No se pudo enviar el presupuesto: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function acceptQuote(button) {
    button.disabled = true;
    showMessage("");
    try {
        const { error } = await supabase.rpc("accept_quote", {
            p_request_id: button.dataset.acceptQuote
        });
        if (error) throw error;
        const user = await getAuthenticatedUser();
        if (await showDashboard(user)) {
            showMessage("Presupuesto aceptado. El administrador ya puede continuar con la fabricación.");
        }
    } catch (error) {
        showMessage(`No se pudo aceptar el presupuesto: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function rejectQuote(button) {
    if (!window.confirm("¿Quieres rechazar este presupuesto? La petición pasará al historial.")) {
        return;
    }
    button.disabled = true;
    showMessage("");
    try {
        const { error } = await supabase.rpc("reject_quote", {
            p_request_id: button.dataset.rejectQuote
        });
        if (error) throw error;
        const user = await getAuthenticatedUser();
        if (await showDashboard(user)) {
            showMessage("Presupuesto rechazado. La petición ya está en tu historial.");
        }
    } catch (error) {
        showMessage(`No se pudo rechazar el presupuesto: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function updateStatus(event, form) {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const nextStatus = form.elements.status.value;
    if (nextStatus === "completed" &&
        !window.confirm("¿Quieres finalizar este pedido y moverlo al historial?")) {
        return;
    }
    if (nextStatus === "rejected" &&
        !window.confirm("¿Quieres marcar este presupuesto como rechazado y moverlo al historial?")) {
        return;
    }
    button.disabled = true;
    showMessage("");
    try {
        const { error } = await supabase.rpc("set_request_status", {
            p_request_id: form.dataset.statusForm,
            p_status: nextStatus
        });
        if (error) throw error;
        const user = await getAuthenticatedUser();
        if (await showDashboard(user)) {
            showMessage(nextStatus === "completed"
                ? "Pedido finalizado y movido al historial."
                : "Pedido marcado como en fabricación.");
        }
    } catch (error) {
        showMessage(`No se pudo actualizar el pedido: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function initialize() {
    if (window.location.protocol === "file:") {
        showMessage("Para usar Supabase, abre el sitio desde un servidor local o web (por ejemplo, VS Code Live Server).", true);
        return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error) {
        showMessage(`No se pudo comprobar la sesión: ${error.message}`, true);
        return;
    }
    if (data.session) {
        await showDashboard(data.session.user);
    }
}

setAuthMode("login");
initialize();
