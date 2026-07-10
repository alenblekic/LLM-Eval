import express from 'express';
import { app as evalApp } from '../src/app.js';

// Vercel's Express auto-detection requires the express() call to happen in
// this file directly, so we create a thin wrapper here and mount the real
// app (defined once in src/app.js and reused by the local dev server too).
const app = express();
app.use(evalApp);

export default app;
