import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import businessPartnerRoutes from './routes/businessPartners.js';
import entitiesRoutes from './routes/entities.js';
import chatRoutes, { TOOLS } from './routes/chat.js';
import debugRoutes from './routes/debug.js';
import knowledgeBaseRoutes from './routes/knowledgeBase.js';
import bomRoutes from './routes/bom.js';
import sapRoutes from './routes/sap.js';
import materialCheckRoutes from './routes/materialCheck.js';
import { enforceHttps, safeLogger } from './middleware/security.js';
import { verifyAllToolsSafety } from './config/riskLevels.js';
import { listSystems, DEFAULT_SYSTEM, getSystemConfig } from './config/systemRegistry.js';

// Load environment configuration
dotenv.config();
console.log("SAP_DEV_URL loaded as:", process.env.SAP_DEV_URL);

// Startup safety verification: Strictly enforce Level 4 tool blocking and confirmation gates
verifyAllToolsSafety(TOOLS);

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Trust proxy for secure cookies and rate-limiting when behind reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(enforceHttps);
app.use(safeLogger);
app.use(express.json());
app.use(cookieParser());

// CORS configuration supporting credentials (cookies)
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/business-partners', businessPartnerRoutes);
app.use('/api/entities', entitiesRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/knowledge-base', knowledgeBaseRoutes);
app.use('/api/bom', bomRoutes);
app.use('/api/sap', sapRoutes);
app.use('/api/materials', materialCheckRoutes);

// Multi-system discovery endpoint
app.get('/api/systems', (req, res) => {
  res.status(200).json({
    defaultSystem: DEFAULT_SYSTEM,
    systems: listSystems()
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mockMode: process.env.USE_MOCK_SAP !== 'false'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler (never leak stack trace or credentials in response)
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Start server only when executed directly (not when imported in tests)
const isMainModule = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.basename(process.argv[1]) === 'server.js'
);
if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`SAP Application Backend Service Running`);
    console.log(`Port: ${PORT}`);
    console.log(`Mode: ${process.env.USE_MOCK_SAP !== 'false' ? 'Mock Data Layer' : 'Real SAP Gateway'}`);
    const activeBaseUrl = getSystemConfig(DEFAULT_SYSTEM)?.baseUrl || '(not configured)';
    console.log(`SAP Base URL (${DEFAULT_SYSTEM}): ${activeBaseUrl}`);
    console.log(`Frontend URL: ${FRONTEND_URL}`);
    console.log(`=============================================`);
  });
}

export default app;
