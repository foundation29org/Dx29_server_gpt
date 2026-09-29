const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

// Contrato público de desarrollo exportado desde API Management (JSON).
const openApiPath = path.join(__dirname, '../docs/dxgptapi-dev-yaml');
const fileContents = fs.readFileSync(openApiPath, 'utf8');
const swaggerSpec = JSON.parse(fileContents);

// Crear una app Express simple para servir Swagger UI
const app = express();
const port = process.env.PORT || 3000;

// Montar Swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Punto final para obtener la especificación en formato JSON
app.get('/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Redirigir la raíz a la documentación
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Swagger UI running at http://localhost:${port}/docs`);
  console.log(`OpenAPI specification available at http://localhost:${port}/swagger.json`);
}); 