# Balam — Virtual Try-On PWA

Probador virtual de moda de diseñador con avatar generado por IA.

## 🚀 Inicio Rápido

**Windows:** Doble clic en `START.bat`

**Manual:**
```bash
# Terminal 1 — Backend
cd backend && npm install && node server.js

# Terminal 2 — Frontend  
cd frontend && npx http-server . -p 3000 -c-1 --cors -o
```

Abrir: http://localhost:3000

## 📱 Flujo de la App

1. **Landing** → "Crear mi avatar"
2. **Create Likeness** → Continue
3. **Upload 2 fotos** → Upload Images
4. **Processing** → Avatar generándose (~3s demo)
5. **Main Try-On** → Selecciona prenda → Se aplica instantáneamente

## 🔌 API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/garments` | Lista de prendas |
| GET | `/api/garments?category=guayabera` | Filtrar por categoría |
| POST | `/api/avatar/upload` | Subir fotos y generar avatar |
| POST | `/api/tryon` | Procesar try-on virtual |
| POST | `/api/wardrobe` | Guardar look |
| GET | `/api/wardrobe/:sessionId` | Ver armario |

## 🎨 Categorías disponibles
- `guayabera` — Camisas guayaberas
- `tshirt-premium` — Camisetas de diseñador
- `linen-shirt` — Camisas de lino
- `polo` — Polos

## 🔧 Para producción (IA real)

En `backend/server.js`, reemplaza el mock en `/api/tryon` con:

```js
// Fashn.ai (recomendado)
const response = await fetch('https://api.fashn.ai/v1/run', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${process.env.FASHN_API_KEY}` },
  body: JSON.stringify({
    model: 'tryon-v1',
    input: { person_image: avatarUrl, garment_image: garment.image }
  })
});
```

## 📦 Stack
- **Frontend:** HTML5 + CSS3 + Vanilla JS (PWA)
- **Backend:** Node.js + Express
- **Fuentes:** Cormorant Garamond + DM Sans
- **Deploy:** Cualquier servidor estático (Vercel, Netlify) + backend en Railway/Render
