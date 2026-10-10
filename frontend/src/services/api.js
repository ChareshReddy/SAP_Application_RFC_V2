import axios from 'axios';

// Create Axios client with credentials included for HttpOnly cookie persistence
const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  }
});

/**
 * Validates credentials via backend SAP authentication endpoint.
 * Never stores or exposes raw password to frontend state.
 */
export async function loginUser(username, password) {
  const response = await apiClient.post('/auth/login', { username, password });
  return response.data;
}

/**
 * Logs out user, invalidating session in backend and clearing cookie.
 */
export async function logoutUser() {
  const response = await apiClient.post('/auth/logout');
  return response.data;
}

/**
 * Checks if current session is active and valid.
 */
export async function checkSession() {
  const response = await apiClient.get('/auth/me');
  return response.data;
}

/**
 * Retrieves authentication configuration (e.g. skipGatewayAuth, bypassUser, mockMode).
 */
export async function getAuthConfig() {
  const response = await apiClient.get('/auth/config');
  return response.data;
}

/**
 * Fetches available SAP entities from registry.
 */
export async function getEntities() {
  const response = await apiClient.get('/entities');
  return response.data?.entities || [];
}

/**
 * Fetches records for a specific SAP entity with pagination and filtering.
 * @param {string} entityKey
 * @param {object} options
 */
export async function getEntityRecords(entityKey, { from, to, top = 50, skip = 0, systemKey } = {}) {
  const params = {};
  if (from) params.from = from;
  if (to) params.to = to;
  if (top !== undefined) params.top = top;
  if (skip !== undefined) params.skip = skip;
  if (systemKey) params.systemKey = systemKey;

  const response = await apiClient.get(`/entities/${entityKey}`, { params });
  return response.data;
}

/**
 * Legacy helper: Fetches SAP Business Partners with optional ID range filter and pagination.
 * @param {object} options { from, to, top, skip }
 */
export async function getBusinessPartners(options = {}) {
  return getEntityRecords('businessPartner', options);
}

/**
 * Sends user prompt and prior history to the conversational AI endpoint.
 * Returns { reply: string, data: array | null, proposedAction: object | null, entityKey?: string }
 * 
 * @param {string} message
 * @param {Array} [history]
 * @param {string} [systemKey='DEV']
 */
export async function sendChatMessage(message, history = [], systemKey = 'DEV', extra = {}) {
  const response = await apiClient.post('/chat', { message, history, systemKey, ...extra });
  return response.data;
}

/**
 * Confirms and executes a proposed write action by its unique actionId.
 * Supports optional business reason and PROD double-confirmation.
 * @param {string} actionId
 * @param {object} [options]
 * @param {string} [options.reason]
 * @param {string} [options.prodConfirmation]
 * @param {string} [options.systemKey]
 * @param {boolean} [options.copySubBoms]
 */
export async function confirmChatAction(actionId, { reason, prodConfirmation, systemKey, copySubBoms } = {}) {
  const response = await apiClient.post('/chat', {
    confirmAction: actionId,
    reason: reason || undefined,
    prodConfirmation: prodConfirmation || undefined,
    systemKey: systemKey || undefined,
    copySubBoms: copySubBoms !== undefined ? copySubBoms : undefined
  });
  return response.data;
}

/**
 * Cancels a proposed write action.
 * @param {string} actionId
 */
export async function cancelChatAction(actionId) {
  const response = await apiClient.post('/chat', { cancelAction: actionId });
  return response.data;
}

/**
 * Fetches available SAP system environments (DEV, QA, PROD).
 */
export async function getSystems() {
  const response = await apiClient.get('/systems');
  return response.data;
}

/**
 * Fetches the Error Knowledge Base catalogue with occurrence metrics.
 */
export async function getKnowledgeBase() {
  const response = await apiClient.get('/knowledge-base');
  return response.data;
}

/**
 * Creates a new Error Knowledge Base rule.
 */
export async function createKnowledgeBaseRule(rule) {
  const response = await apiClient.post('/knowledge-base', rule);
  return response.data;
}

/**
 * Updates an existing Error Knowledge Base rule.
 */
export async function updateKnowledgeBaseRule(id, updates) {
  const response = await apiClient.put(`/knowledge-base/${id}`, updates);
  return response.data;
}

/**
 * Deletes an Error Knowledge Base rule.
 */
export async function deleteKnowledgeBaseRule(id) {
  const response = await apiClient.delete(`/knowledge-base/${id}`);
  return response.data;
}

/**
 * Validates a Source / Reference BOM against SAP GUI (CS03) or mock data.
 * @param {object} params { material, plant, bomUsage, alternativeBom }
 * @returns {Promise<{ success: boolean, materialExists?: boolean, plantValid?: boolean, bomExists?: boolean, alternativeValid?: boolean, availableAlternatives?: string[], componentCount?: number, message: string, errorCode?: string }>}
 */
export async function validateSourceBom(params) {
  const response = await apiClient.post('/bom/validate-source', params);
  return response.data;
}

/**
 * Validates a batch of BOM items against SAP via high-speed RFC.
 * @param {Array<object>} items
 * @returns {Promise<{ success: boolean, totalItems: number, validCount: number, warningCount: number, errorCount: number, results: Array<object> }>}
 */
export async function batchValidateBoms(items) {
  const response = await apiClient.post('/bom/batch-validate', { items });
  return response.data;
}

/**
 * Executes batch BOM copy sequentially via SAP RFC.
 * @param {Array<object>} items
 * @param {object} [options={ skipErrors: true }]
 * @returns {Promise<{ success: boolean, totalProcessed: number, successCount: number, failedCount: number, results: Array<object> }>}
 */
export async function batchCopyBoms(items, options = { skipErrors: true }) {
  const response = await apiClient.post('/bom/batch-copy', { items, ...options });
  return response.data;
}

/**
 * Downloads the official Excel template for Bulk BOM Copy.
 */
export async function downloadBomTemplate() {
  const response = await apiClient.get('/bom/template', {
    responseType: 'blob'
  });
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', 'BOM_Copy_Template.xlsx');
  document.body.appendChild(link);
  link.click();
  link.parentNode.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Fetches current SAP GUI session health and connectivity status.
 * @returns {Promise<{ connected: boolean, status: string, system?: string, client?: string, user?: string, message?: string, code?: string, selectedSessionId?: string, sessions?: Array<object> }>}
 */
export async function getSapSessionStatus() {
  const response = await apiClient.get('/sap/session-status');
  return response.data;
}

/**
 * Fetches all available SAP GUI sessions and active selection.
 * @returns {Promise<{ success: boolean, selectedSessionId: string|null, selectedUser: string|null, sessions: Array<object>, status?: string, connected?: boolean }>}
 */
export async function getSapSessions() {
  const response = await apiClient.get('/sap/sessions');
  return response.data;
}

/**
 * Selects an active SAP GUI session for all future SAP operations.
 * @param {string} sessionId
 * @returns {Promise<{ success: boolean, selectedSessionId: string, selectedUser: string, message: string, session?: object }>}
 */
export async function selectSapSession(sessionId) {
  const response = await apiClient.post('/sap/sessions/select', { sessionId });
  return response.data;
}

export default apiClient;


