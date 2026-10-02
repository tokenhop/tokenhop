# Integración con Cursor

Integra tokenhop con Cursor IDE para enrutar tus solicitudes de IA a través del sistema de enrutamiento inteligente de tokenhop.

## Requisitos previos

- Cursor IDE instalado
- Cuenta Cursor Pro (requerida para endpoints de API personalizados)
- tokenhop accesible vía HTTPS público (ver [Exponer tokenhop a Cursor](#exponer-tokenhop-a-cursor))
- API key del dashboard de tokenhop

## ⚠️ Notas importantes

> **URL pública requerida**: Cursor envía las solicitudes desde sus propios servidores, por lo que no puede alcanzar `localhost`. Dale una URL HTTPS pública de tu propia instancia de tokenhop, como la URL del túnel de Cloudflare o de Tailscale Funnel desde la página **Endpoint** del dashboard, o un despliegue en VPS. tokenhop no tiene un gateway hospedado.

> **Cursor Pro requerido**: Esta característica requiere una cuenta Cursor Pro para usar endpoints de API personalizados.

## Configuración

### 1. Abrir la configuración de Cursor

1. Abre Cursor IDE
2. Ve a **Settings** (Cmd/Ctrl + ,)
3. Navega a la sección **Models**

### 2. Habilitar OpenAI API

1. Encuentra la opción **OpenAI API key**
2. Activa el toggle para habilitar la configuración de API personalizada

### 3. Configurar Base URL

Establece la URL base a la URL pública de tu instancia de tokenhop, seguida de `/v1`:

```
https://<your-tokenhop-host>/v1
```

**Pasos:**

1. En la configuración de Models, localiza el campo **Base URL**
2. Ingresa: `https://<your-tokenhop-host>/v1`
3. Clic en **Save**

### 4. Agregar API Key

1. En el campo **API Key**, ingresa tu API key de tokenhop
2. Puedes encontrar tu API key en el dashboard de tokenhop en **Settings → API Keys**
3. Clic en **Save**

### 5. Agregar modelo personalizado

1. Clic en el botón **View All Models**
2. Clic en **Add Custom Model**
3. Ingresa el nombre del modelo desde tu configuración de tokenhop (ej. `gpt-4`, `claude-opus-4-5`, etc.)
4. Clic en **Add**

### 6. Seleccionar modelo

1. En la interfaz de chat de Cursor, clic en el dropdown selector de modelo
2. Elige tu modelo personalizado de la lista
3. ¡Empieza a usar tokenhop con Cursor!

## Ejemplo de configuración

Tu configuración de Cursor debería verse así:

```
OpenAI API: ✓ Enabled
Base URL: https://<your-tokenhop-host>/v1
API Key: sk-xxxxxxxxxxxxxxxx
Custom Models: gpt-4, claude-opus-4-5, gemini-2.0-flash
```

## Modelos disponibles

Puedes usar cualquier modelo configurado en tu dashboard de tokenhop. Ejemplos comunes:

| Nombre del modelo   | Proveedor | Descripción       |
| ------------------- | --------- | ----------------- |
| `gpt-4`             | OpenAI    | GPT-4 Turbo       |
| `gpt-4o`            | OpenAI    | GPT-4 Optimized   |
| `claude-opus-4-5`   | Anthropic | Claude Opus 4.5   |
| `claude-sonnet-4-5` | Anthropic | Claude Sonnet 4.5 |
| `gemini-2.0-flash`  | Google    | Gemini 2.0 Flash  |

## Uso

### Interfaz de chat

1. Abre el chat de Cursor (Cmd/Ctrl + L)
2. Selecciona tu modelo del dropdown
3. Comienza a chatear con IA a través de tokenhop

### Generación de código inline

1. Selecciona código en tu editor
2. Presiona Cmd/Ctrl + K
3. Ingresa tu prompt
4. Cursor usará tokenhop para generar código

### Explicación de código

1. Selecciona código en tu editor
2. Presiona Cmd/Ctrl + L
3. Pregunta "Explain this code"
4. Obtén explicaciones potenciadas por IA a través de tokenhop

## Solución de problemas

### Error "Invalid API Key"

1. Verifica tu API key en el dashboard de tokenhop
2. Asegúrate de haber copiado la key completa incluyendo el prefijo `sk-`
3. Verifica que la API key no haya expirado
4. Intenta regenerar una nueva API key

### Error "Model Not Found"

1. Verifica que el nombre del modelo coincida exactamente con tu configuración de tokenhop
2. Verifica que la conexión del proveedor esté activa en el dashboard de tokenhop
3. Asegúrate de que el modelo esté disponible en tus proveedores conectados
4. Intenta usar el nombre completo del modelo (ej. `openai/gpt-4` en lugar de `gpt-4`)

### Problemas de conexión

1. Verifica que la Base URL sea la URL pública de tu tokenhop seguida de `/v1` (por ejemplo `https://<your-tokenhop-host>/v1`)
2. Abre `/v1/models` de esa URL en un navegador o con `curl` para confirmar que es accesible desde internet
3. Asegúrate de que tu túnel (Cloudflare o Tailscale Funnel) o tu servidor siga activo
4. Intenta deshabilitar VPN o proxy si está habilitado

### Localhost no funciona

> **Recuerda**: Cursor no soporta endpoints localhost. Expón tu instancia local de tokenhop como se describe abajo y usa esa URL pública.

## Exponer tokenhop a Cursor

Si estás ejecutando tokenhop localmente y quieres usarlo con Cursor:

1. Abre el dashboard de tokenhop → **Endpoint**
2. Activa el **túnel de Cloudflare** (una URL `*.trycloudflare.com`) o **Tailscale Funnel** (requiere Tailscale instalado y con sesión iniciada)
3. Copia la URL pública y úsala, seguida de `/v1`, como Base URL en Cursor
4. Activa **Require API key** para que solo tus keys puedan usar la URL pública

Alternativamente, ejecuta tokenhop en un servidor con un dominio público y HTTPS (ver [Cloud (VPS/Docker)](/es/deployment/cloud)), o ponlo detrás de tu propio proxy reverso o túnel.

## Mejores prácticas

1. **Usa aliases de modelos**: Crea aliases cortos para modelos usados con frecuencia en tokenhop
2. **Monitorea el uso**: Revisa el dashboard de tokenhop para estadísticas de uso y costos
3. **Rota las API Keys**: Rota tus API keys regularmente por seguridad
4. **Prueba modelos**: Prueba diferentes modelos para encontrar el mejor para tu caso de uso
