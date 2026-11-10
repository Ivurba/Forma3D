# Forma3D

Sitio web estático de Forma3D publicado con GitHub Pages.

## Desarrollo local

Abre `Web/Html` con un servidor local (por ejemplo, Live Server); el panel de cuenta no funciona desde `file://`.

## Supabase

1. Ejecuta `Web/Html/supabase/setup.sql` en el SQL Editor del proyecto. El script crea o actualiza las tablas, políticas, funciones y el bucket privado.
2. Para permitir restablecer contraseñas, configura `https://ivurba.github.io/Forma3D` como Site URL y añade `https://ivurba.github.io/Forma3D/cuenta.html` a Authentication → URL Configuration → Redirect URLs. El enlace de recuperación redirige siempre a esa página publicada; publica los archivos actualizados antes de probarlo.
3. La clave publishable del cliente puede estar en el frontend; nunca pongas una `service_role` ni otra clave secreta en los archivos web.
4. Para activar los avisos por correo, configura Resend y Supabase:
   - Verifica en Resend el dominio o remitente que quieras usar.
   - En Supabase → Edge Functions → Secrets, añade `RESEND_API_KEY` y `FROM_EMAIL` (el remitente verificado). Al aceptar o rechazar, los avisos se envían a las direcciones de los perfiles con rol `admin`, así que no hace falta guardar otro correo como secreto.
   - Desde una terminal, entra en `Web/Html` y ejecuta `npx supabase login`, `npx supabase link --project-ref yiogvivjcpfckkznrydm` y `npx supabase functions deploy notify-request`.

   Sin desplegar la función y configurar `RESEND_API_KEY`/`FROM_EMAIL`, el cambio de estado se guarda pero no se envía correo. Si aparece HTTP 403, comprueba que `FROM_EMAIL` usa el dominio verificado en la misma cuenta de Resend que emitió `RESEND_API_KEY`. Tras corregir el secreto, el administrador puede pulsar «Reenviar notificación por correo» sin volver a cambiar el estado.

El esquema debe actualizarse antes de que el formulario nuevo pueda guardar cantidad, medidas, material, color y fecha deseada. La configuración de correo y el comportamiento del proyecto Supabase deben comprobarse en el panel real.
