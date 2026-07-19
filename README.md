# Web de BrujerIA

Sitio estático de una página construido siguiendo el **BrujerIA Brand Book v3**.

## Estructura

```
brujeria-web/
├── index.html          Página principal (manifiesto, propósito, servicios, proceso, principios, contacto)
├── gracias.html        Confirmación tras enviar el formulario de contacto
├── 404.html            Página de error autocontenida (GitHub Pages la sirve automáticamente)
├── css/styles.css      Estilos (Space Grotesk + Space Mono vía Google Fonts)
├── js/main.js          Mejora progresiva: revelado sutil y sección activa en la navegación
└── assets/             Logotipo, trazo, favicon y og-image extraídos del brand book
```

## Reglas de marca aplicadas

- **Tres colores, nada más**: Negro `#141414`, Blanco `#FEFEFE`, Vermellón `#E8380D` (siempre por debajo del 5 % de la pieza; señala, no decora).
- **Tipografía**: Space Grotesk (Light/Regular/Medium/Bold) como voz principal; Space Mono para cabeceras de sección, etiquetas y datos técnicos. Jerarquía por tamaño y peso, nunca por color ni subrayado.
- **Composición**: margen mínimo del 6 % en los cuatro lados (`--margen: 6vw`), texto alineado a la izquierda, sin justificar, una idea por sección, el vacío se respeta.
- **El trazo**: ángulo original de 32°, sin rotar ni deformar (se usa el asset extraído del brand book). Un solo trazo en toda la página: firma el cierre (sección de contacto), no decora. En `assets/` quedan las variantes negro/blanco a alta resolución como kit de marca.
- **Logotipo**: variantes positivo/negativo del brand book, altura mínima digital de 24 px respetada (32 px en el pie).

## Formulario de contacto

El formulario envía los datos mediante [FormSubmit](https://formsubmit.co) (gratuito,
sin cuenta): cada envío llega por correo al buzón del propietario con el asunto
"Nuevo contacto desde la web de BrujerIA". El `action` usa el alias aleatorio de
FormSubmit para no exponer la dirección real en el código. El visitante no necesita
iniciar sesión. Incluye campo honeypot antispam y redirige a `gracias.html` tras el
envío. Cuando exista `hola@brujeria.es`, basta con cambiar el `action` del formulario
en `index.html` por el nuevo buzón (y reactivar FormSubmit desde ese buzón).

## Publicación

Es un sitio 100 % estático: puede subirse tal cual a cualquier hosting
(Netlify, Vercel, GitHub Pages, un servidor propio…). No requiere build.

Para verlo en local basta con abrir `index.html` en el navegador
o servir la carpeta con cualquier servidor estático.
