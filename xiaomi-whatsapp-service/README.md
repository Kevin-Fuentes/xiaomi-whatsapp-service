# Xiaomi Cartagena WhatsApp Service

Servicio nuevo para recuperar el flujo anterior de QR + sesión persistente + envíos automáticos.

## Compatible con el frontend viejo

- GET `/api/whatsapp/status`
- POST `/api/whatsapp/connect`
- POST `/api/whatsapp/disconnect`
- GET `/api/whatsapp/templates`
- PUT `/api/whatsapp/templates`

También incluye:

- POST `/api/whatsapp/send`
- POST `/api/whatsapp/order`
- POST `/api/whatsapp/reminder`
- GET `/health`

## Railway

1. Crea proyecto nuevo.
2. Sube este código vía GitHub o Railway CLI.
3. Crea un **Volume** y móntalo en `/data`.
4. Variables:
   - `DATA_DIR=/data`
   - `ALLOWED_ORIGINS=https://xiaomicartagena.com,https://www.xiaomicartagena.com`
   - `AUTO_CONNECT=false`
   - `LOG_LEVEL=info`
5. Genera dominio público.
6. Prueba `GET /health`.
7. Haz `POST /api/whatsapp/connect`.
8. Consulta `GET /api/whatsapp/status`. Debe pasar `loading -> qr_ready` y devolver `qr`.

El frontend viejo recibe además:
- Socket.IO `whatsapp-qr`
- Socket.IO `whatsapp-status`

## Importante

Usa Baileys (sesión tipo WhatsApp Web), evitando Chromium/Puppeteer. Es más liviano para Railway, pero sigue siendo una integración no oficial. Para máxima estabilidad comercial, Meta WhatsApp Business Cloud API es la alternativa oficial.
