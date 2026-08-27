# Xiaomi Cartagena WhatsApp Service — v4 Playwright/Chromium

Esta versión reemplaza Baileys por **WhatsApp Web real ejecutado dentro de Chromium headless con Playwright**.

## Qué conserva

Los mismos endpoints del frontend:

- `GET /api/whatsapp/status`
- `POST /api/whatsapp/connect`
- `POST /api/whatsapp/disconnect`
- `POST /api/whatsapp/reset-session`
- `GET/PUT /api/whatsapp/templates`
- `POST /api/whatsapp/order`
- `POST /api/whatsapp/in-store`
- `POST /api/whatsapp/owner-alert`
- `POST /api/whatsapp/reminder`
- campañas y clientes

Por eso no hace falta cambiar el frontend nuevamente.

## Sesión

Chromium usa un perfil persistente en:

`/data/whatsapp-profile`

Railway debe tener un **Volume montado en `/data`**. Así el perfil de WhatsApp Web sobrevive a reinicios/deploys.

## POS

La confirmación de tienda física sigue programada a los 10 minutos y la cola sigue persistida en `/data`.

## Railway

La carpeta incluye `Dockerfile` basado en la imagen oficial de Microsoft Playwright:

`mcr.microsoft.com/playwright:v1.55.0-noble`

Variables recomendadas:

```env
DATA_DIR=/data
ALLOWED_ORIGINS=https://xiaomicartagena.com,https://www.xiaomicartagena.com
OLD_BACKEND_URL=https://xiaomictg-backend-production.up.railway.app
AUTO_CONNECT=true
LOG_LEVEL=info
POS_MESSAGE_DELAY_MS=600000
```

## Flujo de prueba

1. Deploy.
2. `POST /api/whatsapp/reset-session`
3. `POST /api/whatsapp/connect`
4. `GET /api/whatsapp/status`
5. Cuando sea `qr_ready`, escanear con WhatsApp Business.
6. Reconsultar `/status`; debe pasar a `connected`.
7. Reiniciar Railway y comprobar que vuelva a `connected` sin QR.

## Nota

Esto automatiza WhatsApp Web, no es la WhatsApp Business Cloud API oficial. Puede requerir mantenimiento si WhatsApp cambia su interfaz y no ofrece las mismas garantías que la API oficial.
