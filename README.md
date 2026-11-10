# Forma3D

Sitio web estático de Forma3D publicado con GitHub Pages.

## Desarrollo local

Abre `Web/Html` con un servidor local (por ejemplo, Live Server); el panel de cuenta no funciona desde `file://`.

## Supabase

1. Ejecuta `Web/Html/supabase/setup.sql` en el SQL Editor del proyecto. El script crea o actualiza las tablas, políticas, funciones y el bucket privado.
2. Para permitir restablecer contraseñas, añade la URL publicada del sitio a la lista de Redirect URLs en Authentication → URL Configuration.
3. La clave publishable del cliente puede estar en el frontend; nunca pongas una `service_role` ni otra clave secreta en los archivos web.
4. Para activar los avisos por correo, verifica un remitente en Resend y guarda `RESEND_API_KEY` y `FROM_EMAIL` en Supabase → Edge Functions → Secrets. Desde `Web/Html`, despliega con `supabase functions deploy notify-request --project-ref <project-ref>`. La función solo acepta solicitudes de administradores autenticados.

El esquema debe actualizarse antes de que el formulario nuevo pueda guardar cantidad, medidas, material, color y fecha deseada. La configuración de correo y el comportamiento del proyecto Supabase deben comprobarse en el panel real.
