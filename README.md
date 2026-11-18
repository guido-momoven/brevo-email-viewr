# Visor de mails Momoven (Netlify)

Visor de mails de Brevo con búsqueda de contactos de ejemplo. La página es estática; la búsqueda real pasa por una función de Netlify que guarda la clave de Brevo y pide una contraseña de equipo.

```
visor-mails/
├─ netlify.toml                      configuración (carpeta pública, funciones y /api/contactos)
├─ public/
│  ├─ index.html                     el visor
│  ├─ semillas.json                  escenarios de prueba (editable sin tocar código)
│  └─ robots.txt                     pide a los buscadores que no lo indexen
├─ netlify/functions/contactos.js    la función que habla con Brevo
└─ test/contactos.test.js            pruebas de la función
```

## Ponerlo en marcha (una vez)

1. **Repositorio.** Crea un repositorio **privado** en GitHub y sube esta carpeta entera.
2. **Sitio en Netlify.** Add new site → Import an existing project → GitHub → el repositorio. Deja vacío el comando de build; la carpeta pública (`public`) y las funciones ya están en `netlify.toml`.
   Para conservar la dirección del sitio actual, prueba Site configuration → Build & deploy → Continuous deployment → Link repository. Si no te deja, crea un sitio nuevo y ponle el nombre que quieras.
3. **Variables de entorno.** Site configuration → Environment variables:
   - `BREVO_API_KEY`: crea una clave nueva solo para esta herramienta (Brevo → SMTP & API → API Keys). Así puedes rotarla sin romper otros scripts.
   - `MASTER_PASSWORD`: una frase larga (4 palabras o más), no una palabra suelta.
   - Marca ambas como secretas si Netlify te lo ofrece.
4. **Publicar.** Deploys → Trigger deploy → Deploy site.
5. **Probar.** Abre la dirección, pega el HTML de un mail, pestaña «En Brevo», elige condiciones y pulsa «Buscar contactos».

## Cambiar la contraseña cada cierto tiempo

1. Cambia `MASTER_PASSWORD` en Netlify.
2. Deploys → Trigger deploy (los cambios de variables se aplican en el siguiente deploy).
3. Pásasela a Nico por un gestor de contraseñas, no por un chat abierto.

## Qué datos salen y cuáles no

- Máximo 10 contactos por búsqueda, con su email y los atributos de la lista `PERMITIDOS` de `contactos.js` (idioma, tipo de usuario, estado de reserva, `SEARCH_*`, `HOST_HAS_*`).
- Nunca `NOMBRE` ni otros datos personales. Tampoco contactos dados de baja de email.
- En pantalla el email se ve enmascarado; «Copiar email» copia el completo para buscarlo en Brevo.
- No se guarda nada. Los registros de Netlify solo dicen qué atributos se consultaron y cuántos contactos salieron, sin emails.
- Para permitir otro atributo, añádelo a la variable `ATRIBUTOS_PERMITIDOS` (lista separada por comas, sustituye a la de serie) o a `PERMITIDOS` en el código. Debe llamarse igual que en Brevo.

## Escenarios de prueba (contactos semilla)

`public/semillas.json` define escenarios (propietario IB, RTB, mixto, rider en curso, etc.). Cada uno carga sus valores en el visor con un clic. Si creas en Brevo un contacto de prueba para un escenario, pon su email en el campo `email` y aparecerá con botón de copiar. No pongas emails de usuarios reales.

## Pruebas

```
node test/contactos.test.js
```

## Límites que conviene conocer

- Una sola contraseña compartida: no queda rastro de quién hace cada consulta.
- Tras 5 intentos fallidos desde una misma IP en 10 minutos se bloquea durante un rato. Es un freno de mejor esfuerzo: la memoria de la función se reinicia.
- Revisa como máximo los 2.000 contactos más recientes de la consulta. Si el filtro es muy amplio, usa un segmento.
- Brevo solo aplica un filtro `equals` por consulta; la función comprueba todos los demás con los contactos que recibe.
- La búsqueda solo funciona en la versión publicada. Abierto como archivo local, el visor sigue funcionando pero sin esa búsqueda.
