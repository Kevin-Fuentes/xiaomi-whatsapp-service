# Xiaomi Cartagena WhatsApp Service

Servicio WhatsApp nuevo para QR, sesión persistente, plantillas y automatizaciones.

## Funcionalidades
- QR / conectar / desconectar / estado por REST + Socket.IO
- Plantilla Cliente (Pedido Web)
- Plantilla Cliente (Tienda Física / POS)
- Plantilla Dueño (alertas)
- Recordatorios CrediLock
- Campañas masivas y programadas con persistencia en `/data`
- Lista de clientes agregada desde órdenes + financiamiento del backend existente

## Variables Railway
DATA_DIR=/data
ALLOWED_ORIGINS=https://xiaomicartagena.com,https://www.xiaomicartagena.com
OLD_BACKEND_URL=https://xiaomictg-backend-production.up.railway.app
AUTO_CONNECT=false
LOG_LEVEL=info

## Volume
Montar un Railway Volume en `/data`.

## Endpoints principales
GET/POST /api/whatsapp/status|connect|disconnect
GET/PUT /api/whatsapp/templates
POST /api/whatsapp/order
POST /api/whatsapp/in-store
POST /api/whatsapp/owner-alert
POST /api/whatsapp/reminder
GET/POST/DELETE /api/whatsapp/campaigns...
GET /api/whatsapp/customers


## Mensajes POS diferidos
El mensaje al cliente de tienda física se programa 10 minutos después. La cola se guarda en `/data/pos-message-queue.json`; con un Railway Volume montado en `/data` sobrevive reinicios. La alerta al dueño es inmediata. Las variables `{{puntosGanados}}` y `{{puntosBalance}}` se reciben desde el frontend.
