import { supabase } from "./supabase.js";

const publishedAccountUrl = "https://ivurba.github.io/Forma3D/cuenta.html";
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
const recoveryForm = document.querySelector("#password-recovery-form");
const feedback = document.querySelector("#feedback");
const modeButton = document.querySelector("#mode-button");
const forgotPasswordButton = document.querySelector("#forgot-password");
const authSubmit = document.querySelector("#auth-submit");
const authHeading = document.querySelector("#auth-heading");
const fileInput = requestForm.elements.model;
const selectedFileMessage = document.querySelector("#selected-file");
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

function formatRequestedDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium" })
        .format(new Date(`${value}T12:00:00`));
}

function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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
    forgotPasswordButton.hidden = registering;
    document.querySelector("#auth-intro").textContent = registering
        ? "Regístrate para solicitar presupuestos y seguir tus pedidos."
        : "Entra para enviar tu modelo 3D y consultar tus presupuestos.";
    authForm.elements.password.autocomplete = registering ? "new-password" : "current-password";
}

function setPasswordRecoveryMode(enabled) {
    authHeading.textContent = enabled ? "Restablece tu contraseña" : "Inicia sesión";
    authForm.hidden = enabled;
    document.querySelector("#auth-links").hidden = enabled;
    recoveryForm.hidden = !enabled;
    document.querySelector("#auth-intro").textContent = enabled
        ? "Elige una contraseña nueva de al menos 8 caracteres."
        : "Entra para enviar tu modelo 3D y consultar tus presupuestos.";
    if (enabled) recoveryForm.elements.password.focus();
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
    const timeline = request.status === "rejected"
        ? [["Solicitud recibida", "Presupuesto enviado", "Presupuesto rechazado"], 2]
        : [
            ["Solicitud recibida", "Presupuesto enviado", "Presupuesto aceptado", "En fabricación", "Finalizada"],
            { pending: 0, quoted: 1, accepted: 2, in_progress: 3, completed: 4 }[request.status] ?? 0
        ];
    const [timelineLabels, currentTimelineStep] = timeline;
    const timelineMarkup = `<ol class="status-timeline" aria-label="Progreso de la petición">${timelineLabels.map((label, index) => {
        const current = currentTimelineStep === index;
        const className = current ? "is-current" : index < currentTimelineStep ? "is-complete" : "";
        return `<li class="${className}"${current ? ' aria-current="step"' : ""}><span>${escapeHtml(label)}</span></li>`;
    }).join("")}</ol>`;
    const requestDetails = [
        ["Cantidad", `${request.quantity} ${request.quantity === 1 ? "unidad" : "unidades"}`],
        ["Medidas", request.dimensions],
        ["Material", request.material],
        ["Color", request.color],
        ["Fecha deseada", formatRequestedDate(request.desired_date)]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");
    const detailsMarkup = `<dl class="request-details">${requestDetails.map(([label, value]) => `
        <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
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
    const resendAdminNoticeButton = !isAdmin && ["accepted", "rejected"].includes(request.status)
        ? `<button class="button button-secondary resend-notice" type="button" data-notify-admin="${escapeHtml(request.id)}">Reenviar aviso al administrador</button>`
        : "";
    const resendCustomerNoticeButton = isAdmin && request.status !== "pending"
        ? `<button class="button button-secondary resend-notice" type="button" data-notify-customer="${escapeHtml(request.id)}">Reenviar notificación por correo</button>`
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
        ? `<form class="status-form" data-status-form="${escapeHtml(request.id)}" data-current-status="${escapeHtml(request.status)}">
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
        ${timelineMarkup}
        ${detailsMarkup}
        <p class="request-description">${escapeHtml(request.description)}</p>
        ${amount}
        ${note}
        <a class="text-link model-download" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Descargar modelo 3D ↗</a>
        ${acceptButton}
        ${resendAdminNoticeButton}
        ${resendCustomerNoticeButton}
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
    container.querySelectorAll("[data-notify-admin]").forEach(button => {
        button.addEventListener("click", () => resendAdminNotification(button));
    });
    container.querySelectorAll("[data-notify-customer]").forEach(button => {
        button.addEventListener("click", () => resendCustomerNotification(button));
    });
    container.querySelectorAll("[data-quote-form]").forEach(form => {
        form.addEventListener("submit", event => sendQuote(event, form));
    });
    container.querySelectorAll("[data-status-form]").forEach(form => {
        form.addEventListener("submit", event => updateStatus(event, form));
    });
}

async function notifyRequestByEmail(requestId, event = "admin_update") {
    try {
        const { data, error } = await supabase.functions.invoke("notify-request", {
            body: { requestId, event }
        });
        if (error) {
            const context = error.context;
            if (context && typeof context.status === "number" && typeof context.text === "function") {
                let responseText;
                try {
                    responseText = await (typeof context.clone === "function" ? context.clone() : context).text();
                } catch (readError) {
                    const detail = readError instanceof Error ? readError.message : String(readError);
                    return {
                        sent: false,
                        error: `La función de correo respondió con HTTP ${context.status}, pero no se pudo leer su respuesta: ${detail}`
                    };
                }
                if (responseText.trim()) {
                    let responseBody;
                    try {
                        responseBody = JSON.parse(responseText);
                    } catch {
                        responseBody = null;
                    }
                    if (typeof responseBody?.error === "string") {
                        return { sent: false, error: responseBody.error };
                    }
                    return {
                        sent: false,
                        error: `La función de correo respondió con HTTP ${context.status}: ${responseText.trim().slice(0, 300)}`
                    };
                }
                return {
                    sent: false,
                    error: `La función de correo respondió con HTTP ${context.status}. Comprueba que esté desplegada y configurada en Supabase.`
                };
            }
            if (typeof context?.message === "string") {
                return { sent: false, error: context.message };
            }
            if (context && typeof context === "object") {
                const contextType = context.constructor?.name ?? "respuesta";
                const status = typeof context.status === "number" ? `, HTTP ${context.status}` : "";
                return { sent: false, error: `${error.message} (${contextType}${status})` };
            }
        }
        return {
            sent: Boolean(data?.sent),
            error: error ? error.message : typeof data?.error === "string" ? data.error : ""
        };
    } catch (error) {
        return {
            sent: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

async function loadRequests(profile) {
    currentRequestList.innerHTML = '<p class="empty-state">Cargando peticiones…</p>';
    historyRequestList.innerHTML = '<p class="empty-state">Cargando historial…</p>';
    let query = supabase
        .from("requests")
        .select("id, user_id, model_path, model_name, description, quantity, dimensions, material, color, desired_date, status, quote_amount, quote_note, created_at, profiles!requests_user_id_fkey(email)")
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

    const previousRequests = new Map(currentRequests.map(request => [request.id, request]));
    currentRequests = requests.map((request, index) => ({ ...request, signedUrl: signedUrls[index] }));
    if (profile.role === "customer") {
        const changedRequests = currentRequests.flatMap(request => {
            const previous = previousRequests.get(request.id);
            if (!previous) return [];
            if (request.status === "quoted" && previous.status !== "quoted") {
                return [`Tienes un nuevo presupuesto para «${request.model_name}».`];
            }
            if (request.status !== previous.status) {
                return [`«${request.model_name}» ahora está: ${statusLabels[request.status] ?? request.status}.`];
            }
            return [];
        });
        if (changedRequests.length > 0) {
            showMessage(changedRequests.length === 1
                ? changedRequests[0]
                : `Hay ${changedRequests.length} actualizaciones en tus peticiones.`);
        }
    }
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

forgotPasswordButton.addEventListener("click", async () => {
    showMessage("");
    const email = authForm.elements.email.value.trim();
    if (!email) {
        showMessage("Escribe tu correo electrónico y vuelve a pulsar «¿Olvidaste tu contraseña?».", true);
        authForm.elements.email.focus();
        return;
    }

    forgotPasswordButton.disabled = true;
    try {
        const redirectUrl = new URL(publishedAccountUrl);
        redirectUrl.searchParams.set("flow", "recovery");
        const redirectTo = redirectUrl.toString();
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        showMessage("Si existe una cuenta con ese correo, recibirás un enlace para restablecer la contraseña.");
    } catch (error) {
        showMessage(`No se pudo enviar el enlace de recuperación: ${error.message}`, true);
    } finally {
        forgotPasswordButton.disabled = false;
    }
});

recoveryForm.addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("");
    const button = recoveryForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { data, error } = await supabase.auth.updateUser({
            password: recoveryForm.elements.password.value
        });
        if (error) throw error;
        if (!data.user) throw new Error("No se pudo comprobar la cuenta después de cambiar la contraseña.");
        recoveryForm.reset();
        setPasswordRecoveryMode(false);
        if (await showDashboard(data.user)) {
            showMessage("Contraseña actualizada correctamente.");
        }
    } catch (error) {
        showMessage(`No se pudo actualizar la contraseña: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
});

supabase.auth.onAuthStateChange(event => {
    if (event === "PASSWORD_RECOVERY") {
        setPasswordRecoveryMode(true);
    }
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
    const file = fileInput.files[0];
    const description = requestForm.elements.description.value.trim();
    const quantity = Number(requestForm.elements.quantity.value);

    if (!file) {
        showMessage("Selecciona el archivo del modelo 3D.", true);
        return;
    }
    const fileError = getFileValidationError(file);
    if (fileError) {
        showMessage(fileError, true);
        return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        showMessage("La cantidad debe ser un número entero entre 1 y 1000.", true);
        return;
    }
    const desiredDate = requestForm.elements.desired_date.value;
    if (desiredDate && desiredDate < localDateString()) {
        showMessage("La fecha deseada no puede ser anterior a hoy.", true);
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
            description,
            quantity,
            dimensions: requestForm.elements.dimensions.value.trim() || null,
            material: requestForm.elements.material.value || null,
            color: requestForm.elements.color.value.trim() || null,
            desired_date: desiredDate || null
        });

        if (insertError) {
            const { error: cleanupError } = await supabase.storage.from(bucketName).remove([uploadedPath]);
            if (cleanupError) {
                throw new Error(`No se pudo guardar la petición: ${insertError.message}. Tampoco se pudo limpiar el archivo subido: ${cleanupError.message}`);
            }
            throw insertError;
        }

        requestForm.reset();
        selectedFileMessage.textContent = "Formatos 3D admitidos, hasta 50 MB.";
        selectedFileMessage.classList.remove("field-help-error");
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

function getFileValidationError(file) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (!allowedExtensions.has(extension)) {
        return "Formato no admitido. Usa STL, 3MF, OBJ, FBX, GLB, GLTF, STEP, STP, IGES, IGS, PLY, AMF, DAE o BLEND.";
    }
    if (file.size > maxFileSize) {
        return "El archivo supera el límite de 50 MB.";
    }
    return "";
}

fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    selectedFileMessage.classList.remove("field-help-error");
    if (!file) {
        selectedFileMessage.textContent = "Formatos 3D admitidos, hasta 50 MB.";
        return;
    }
    const fileError = getFileValidationError(file);
    if (fileError) {
        selectedFileMessage.textContent = fileError;
        selectedFileMessage.classList.add("field-help-error");
        return;
    }
    selectedFileMessage.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
});

requestForm.elements.desired_date.min = localDateString();

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
        const notification = await notifyRequestByEmail(form.dataset.quoteForm);
        if (await showDashboard(user)) {
            const message = notification.error
                ? `Presupuesto guardado en el panel. El correo no se pudo enviar: ${notification.error}`
                : notification.sent
                    ? "Presupuesto enviado al panel y notificación por correo enviada."
                    : "Presupuesto guardado en el panel, pero no se confirmó el envío del correo.";
            showMessage(message, Boolean(notification.error || !notification.sent));
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
        const notification = await notifyRequestByEmail(button.dataset.acceptQuote, "customer_response");
        if (await showDashboard(user)) {
            showMessage(notification.sent
                ? "Presupuesto aceptado. Hemos avisado al administrador por correo."
                : notification.error
                    ? `Presupuesto aceptado. No se pudo avisar al administrador por correo: ${notification.error}`
                    : "Presupuesto aceptado. No se confirmó el envío del aviso al administrador.",
            !notification.sent);
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
        const notification = await notifyRequestByEmail(button.dataset.rejectQuote, "customer_response");
        if (await showDashboard(user)) {
            showMessage(notification.sent
                ? "Presupuesto rechazado. Hemos avisado al administrador por correo."
                : notification.error
                    ? `Presupuesto rechazado. No se pudo avisar al administrador por correo: ${notification.error}`
                    : "Presupuesto rechazado. No se confirmó el envío del aviso al administrador.",
            !notification.sent);
        }
    } catch (error) {
        showMessage(`No se pudo rechazar el presupuesto: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function resendAdminNotification(button) {
    button.disabled = true;
    showMessage("");
    try {
        const notification = await notifyRequestByEmail(button.dataset.notifyAdmin, "customer_response");
        if (notification.sent) {
            showMessage("Hemos reenviado el aviso al administrador por correo.");
        } else {
            showMessage(notification.error
                ? `No se pudo enviar el aviso: ${notification.error}`
                : "No se confirmó el envío del aviso al administrador.", true);
        }
    } catch (error) {
        showMessage(`No se pudo reenviar el aviso: ${error.message}`, true);
    } finally {
        button.disabled = false;
    }
}

async function resendCustomerNotification(button) {
    button.disabled = true;
    showMessage("");
    try {
        const notification = await notifyRequestByEmail(button.dataset.notifyCustomer);
        showMessage(notification.sent
            ? "Notificación reenviada por correo."
            : notification.error
                ? `No se pudo reenviar la notificación: ${notification.error}`
                : "No se confirmó el envío de la notificación.",
        !notification.sent);
    } catch (error) {
        showMessage(`No se pudo reenviar la notificación: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
        button.disabled = false;
    }
}

async function updateStatus(event, form) {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const nextStatus = form.elements.status.value;
    if (nextStatus === form.dataset.currentStatus) {
        showMessage("La petición ya tiene ese estado.");
        return;
    }
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
        const notification = nextStatus === "pending"
            ? { sent: false, error: "" }
            : await notifyRequestByEmail(form.dataset.statusForm);
        if (await showDashboard(user)) {
            const successMessage = nextStatus === "completed"
                ? "Pedido finalizado y movido al historial."
                : `Estado actualizado: ${(statusLabels[nextStatus] ?? nextStatus).toLowerCase()}.`;
            const message = notification.error
                ? `${successMessage} El correo no se pudo enviar: ${notification.error}`
                : notification.sent
                    ? `${successMessage} Notificación por correo enviada.`
                    : nextStatus === "pending"
                        ? successMessage
                        : `${successMessage} No se confirmó el envío del correo.`;
            showMessage(message, Boolean(notification.error || (nextStatus !== "pending" && !notification.sent)));
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
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const authError = urlParams.get("error_description") || hashParams.get("error_description");
    if (authError) {
        showMessage(`El enlace de recuperación no es válido o ha caducado: ${authError}`, true);
        return;
    }
    const isRecoveryFlow = urlParams.get("flow") === "recovery" || hashParams.get("type") === "recovery";
    if (isRecoveryFlow) {
        setPasswordRecoveryMode(true);
    } else if (data.session) {
        await showDashboard(data.session.user);
    }
}

setAuthMode("login");
initialize();
