import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, Bot, User, Sparkles, AlertTriangle, Trash2, ArrowUpRight, Copy, FileSpreadsheet } from 'lucide-react';
import { sendChatMessage, confirmChatAction, cancelChatAction } from '../services/api';
import EntityTable from './EntityTable';
import ConfirmationCard from './ConfirmationCard';
import CreateBomForm from './CreateBomForm';
import DeleteBomForm from './DeleteBomForm';
import BulkBomCopyModal from './BulkBomCopyModal';

const INITIAL_GREETING = {
  id: 'welcome',
  sender: 'assistant',
  text: "Hello! I am your **SAP AI Operations Assistant**.\n\nYou can ask questions about Bills of Materials, or use the quick actions below to **Copy BOM** (CS01 Copy-From), **Bulk Copy (Excel)**, or **Delete BOM** (ZBOM_COPY). All write and delete actions require your explicit confirmation before execution.",
  data: null,
  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
};

export default function ChatBox({ isActive = true, onActionExecuted, systemKey = 'DEV' }) {
  const [messages, setMessages] = useState([INITIAL_GREETING]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState('');
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);

  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom of chat when new messages arrive or when tab becomes active
  useEffect(() => {
    if (isActive) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, isActive]);

  // Focus textarea when switching into the chat tab
  useEffect(() => {
    if (isActive) {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isActive]);

  // ChatGPT-style auto-resizing textarea based on scrollHeight
  const adjustTextareaHeight = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    // Reset height temporarily so scrollHeight can accurately shrink on deletions
    textarea.style.height = 'auto';

    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
    const maxHeight = isMobile ? 140 : 180;
    const minHeight = 44;
    const scrollHeight = textarea.scrollHeight;

    if (scrollHeight > maxHeight) {
      textarea.style.height = `${maxHeight}px`;
      textarea.style.overflowY = 'auto';
    } else {
      const targetHeight = Math.max(minHeight, scrollHeight);
      textarea.style.height = `${targetHeight}px`;
      textarea.style.overflowY = 'hidden';
    }
  }, []);

  // Adjust height on inputMessage changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [inputMessage, adjustTextareaHeight]);

  // Adjust height on window resize (e.g. mobile orientation change)
  useEffect(() => {
    const handleWindowResize = () => adjustTextareaHeight();
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [adjustTextareaHeight]);

  const resetComposer = () => {
    setInputMessage('');
    if (inputRef.current) {
      inputRef.current.style.height = '44px';
      inputRef.current.style.overflowY = 'hidden';
    }
  };

  const triggerStructuredAction = (actionType) => {
    if (isLoading) return;
    setErrorBanner('');

    if (actionType === 'create_bom') {
      const userMsg = {
        id: Date.now().toString(),
        sender: 'user',
        text: 'Copy BOM',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: 'Please specify the Source (Reference) BOM and Target BOM parameters below:',
        formType: 'create_bom',
        formStatus: 'active',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      return;
    }

    if (actionType === 'delete_bom') {
      const userMsg = {
        id: Date.now().toString(),
        sender: 'user',
        text: 'Delete BOM',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: 'Please specify the Bill of Materials to delete below:',
        formType: 'delete_bom',
        formStatus: 'active',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      return;
    }

    if (actionType === 'bulk_bom_copy') {
      setIsBulkModalOpen(true);
      return;
    }
  };

  const handleBulkExecutionComplete = (response) => {
    const summaryMsg = {
      id: Date.now().toString(),
      sender: 'assistant',
      text: `### 📋 Bulk BOM Copy Execution Completed\n\n- **Total Processed:** ${response.totalProcessed || 0}\n- **Successfully Copied:** ${response.successCount || 0}\n- **Failed / Skipped:** ${response.failedCount || 0}\n\nYou can view and download the full Excel report from the Bulk BOM Copy dialog.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages((prev) => [...prev, summaryMsg]);
    if (onActionExecuted) {
      onActionExecuted('bulk_copy_bom');
    }
  };

  const handleCreateBomCancel = (msgId) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, formStatus: 'cancelled' } : m))
    );
    const cancelMsg = {
      id: (Date.now() + 1).toString(),
      sender: 'assistant',
      text: 'Copy BOM operation was cancelled.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages((prev) => [...prev, cancelMsg]);
  };

  const handleCreateBomSubmit = async (msgId, formData) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, formStatus: 'submitted' } : m))
    );
    setIsLoading(true);
    setErrorBanner('');

    const tgtAltText = formData.targetAltBom ? `, Alt ${formData.targetAltBom}` : '';
    const srcAltText = formData.sourceAltBom ? `, Alt ${formData.sourceAltBom}` : '';
    const summaryText = `Create new BOM for ${formData.targetMaterial} in plant ${formData.targetPlant} (Usage ${formData.targetUsage}${tgtAltText}) by copying from reference BOM ${formData.sourceMaterial} in plant ${formData.sourcePlant} (Usage ${formData.sourceUsage}${srcAltText})`;

    const historyPayload = messages
      .filter((m) => m.id !== 'welcome' && !m.isError && m.text)
      .map((m) => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

    try {
      const response = await sendChatMessage(
        summaryText,
        historyPayload,
        systemKey,
        { actionType: 'copy_bom', copyBomParams: formData }
      );

      const isError = Boolean(response.error);
      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: response.reply || (isError ? 'An error occurred.' : "Here's the proposal to copy the Bill of Materials:"),
        data: null,
        entityKey: response.entityKey || 'bom',
        schema: response.schema || null,
        proposedAction: response.proposedAction || null,
        actionStatus: response.proposedAction ? 'pending' : null,
        isError: isError,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setMessages((prev) => [...prev, assistantMsg]);
      if (isError) {
        setErrorBanner(response.reply || 'Error validating BOM parameters.');
      }
    } catch (err) {
      console.error('Error submitting Copy BOM:', err);
      const errorText = err.response?.data?.reply || err.response?.data?.error || 'Unable to submit Copy BOM request.';
      setErrorBanner(errorText);
      const errorMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: errorText,
        data: null,
        isError: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      if (isActive) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  };

  const handleDeleteBomCancel = (msgId) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, formStatus: 'cancelled' } : m))
    );
    const cancelMsg = {
      id: (Date.now() + 1).toString(),
      sender: 'assistant',
      text: 'Delete BOM operation was cancelled. No records were modified.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages((prev) => [...prev, cancelMsg]);
  };

  const handleDeleteBomSubmit = async (msgId, formData) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, formStatus: 'submitted' } : m))
    );
    setIsLoading(true);
    setErrorBanner('');

    const summaryText = `Delete BOM for Material ${formData.material} in plant ${formData.plant} (Alternative BOM ${formData.alternativeBom}, Usage ${formData.bomUsage})`;

    const historyPayload = messages
      .filter((m) => m.id !== 'welcome' && !m.isError && m.text)
      .map((m) => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

    try {
      const response = await sendChatMessage(
        summaryText,
        historyPayload,
        systemKey,
        { actionType: 'delete_bom', deleteBomParams: formData }
      );

      const isError = Boolean(response.error);
      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: response.reply || (isError ? 'An error occurred.' : "Here's the proposal to delete the Bill of Materials:"),
        data: null,
        entityKey: response.entityKey || 'bom',
        schema: response.schema || null,
        proposedAction: response.proposedAction || null,
        actionStatus: response.proposedAction ? 'pending' : null,
        isError: isError,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setMessages((prev) => [...prev, assistantMsg]);
      if (isError) {
        setErrorBanner(response.reply || 'Error validating Delete BOM parameters.');
      }
    } catch (err) {
      console.error('Error submitting Delete BOM:', err);
      const errorText = err.response?.data?.reply || err.response?.data?.error || 'Unable to submit Delete BOM request.';
      setErrorBanner(errorText);
      const errorMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: errorText,
        data: null,
        isError: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      if (isActive) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  };

  const handleSendMessage = async (textToSend = null) => {
    const text = (textToSend || inputMessage).trim();
    if (!text || isLoading) return;

    // Check if the user is asking to create or delete a BOM
    const isCreateIntent = /^\s*(?:create\s*(?:a\s*)?(?:new\s*)?bom|copy\s*bom)\s*$/i.test(text);
    if (isCreateIntent) {
      resetComposer();
      triggerStructuredAction('create_bom');
      return;
    }

    const isDeleteIntent = /^\s*(?:delete\s*(?:a\s*)?bom|remove\s*bom)\s*$/i.test(text);
    if (isDeleteIntent) {
      resetComposer();
      triggerStructuredAction('delete_bom');
      return;
    }

    const isBulkIntent = /^\s*(?:bulk\s*(?:copy|bom)?|batch\s*(?:copy|bom)?|excel|upload\s*excel|copy\s*excel)\s*$/i.test(text);
    if (isBulkIntent) {
      resetComposer();
      triggerStructuredAction('bulk_bom_copy');
      return;
    }

    setErrorBanner('');
    resetComposer();

    const userMsg = {
      id: Date.now().toString(),
      sender: 'user',
      text,
      data: null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setIsLoading(true);

    // Build prior history for multi-turn context (exclude welcome message & errors)
    const historyPayload = messages
      .filter((m) => m.id !== 'welcome' && !m.isError && m.text)
      .map((m) => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

    try {
      const response = await sendChatMessage(text, historyPayload, systemKey);
      const isError = Boolean(response.error);

      const records = !isError && Array.isArray(response.data) && response.data.length > 0
        ? response.data
        : null;

      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: response.reply || (isError ? 'An error occurred.' : "Here's what I found:"),
        data: records,
        entityKey: response.entityKey || null,
        schema: response.schema || null,
        proposedAction: response.proposedAction || null,
        actionStatus: response.proposedAction ? 'pending' : null,
        isError: isError,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setMessages((prev) => [...prev, assistantMsg]);

      if (isError) {
        setErrorBanner(response.reply || 'An error occurred while processing your request.');
      } else {
        setErrorBanner('');
      }
    } catch (err) {
      const is429 = err.response?.status === 429 || err.response?.data?.isRateLimit;
      const errorText = is429
        ? '⚠️ The AI service is currently busy. Please wait a moment and try again.'
        : err.response?.data?.error ||
          err.response?.data?.reply ||
          'Unable to connect to the AI assistant. Please try again shortly.';

      setErrorBanner(errorText);

      const errorMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: errorText,
        data: null,
        isError: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      if (isActive) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  };

  const handleConfirmAction = async (msgId, actionId, options = {}) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, actionStatus: 'executing' } : m))
    );

    const currentMsg = messages.find((m) => m.id === msgId);
    const proposedAction = currentMsg?.proposedAction;
    const isCopyBom = proposedAction?.type === 'copy_bom';

    try {
      const res = await confirmChatAction(actionId, { ...options, systemKey: options.systemKey || systemKey });
      if (res.error) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, actionStatus: res.expired ? 'expired' : 'failed' } : m
          )
        );
        setErrorBanner(res.reply || 'Execution failed.');
        return;
      }

      // Mark card as confirmed
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, actionStatus: 'confirmed' } : m))
      );

      // Presentation formatting: present as ONE BOM copy operation and show only top-level result
      let formattedReply = res.reply;
      let displayData = res.data && res.data.length > 0 ? res.data : null;
      let displaySchema = res.schema || null;

      const isCopyBomAction = isCopyBom || res.actionExecuted?.type === 'copy_bom' || /Successfully copied.*BOM/i.test(res.reply);

      if (isCopyBomAction) {
        const preview = proposedAction?.preview;
        const targetMat = preview?.targetMaterial || res.actionResult?.after?.material || (Array.isArray(res.data) ? res.data[0]?.material : null) || res.actionExecuted?.recordId;
        const targetPlant = preview?.targetPlant || res.actionResult?.after?.plant || (Array.isArray(res.data) ? res.data[0]?.plant : null);

        if (targetMat && targetPlant) {
          formattedReply = `Successfully copied BOM ${targetMat} to plant ${targetPlant}.\n\nComplete BOM hierarchy copied and verified.`;
        } else if (targetMat) {
          formattedReply = `Successfully copied BOM ${targetMat}.\n\nComplete BOM hierarchy copied and verified.`;
        } else {
          formattedReply = (res.reply || 'Successfully copied BOM.')
            .replace(/^✅\s*/, '')
            .replace(/complete BOM hierarchy for\s+([A-Z0-9_-]+)\s*\([^)]*\)/i, 'BOM $1')
            .replace(/\s*\(\d+\s*BOMs?\s*created[^)]*\)/i, '') + '\n\nComplete BOM hierarchy copied and verified.';
        }

        // Show only the original / top-level BOM requested by the user
        const rawTopRecord = res.actionResult?.after ||
          (Array.isArray(res.data) ? res.data.find((r) => r.isMain || r.depth === 0) : null) ||
          (Array.isArray(res.data) && preview?.targetMaterial ? res.data.find((r) => r.material === preview.targetMaterial) : null) ||
          (Array.isArray(res.data) ? res.data[0] : null);

        if (rawTopRecord) {
          const topLevelRecord = {
            ...rawTopRecord,
            material: rawTopRecord.material || preview?.targetMaterial || targetMat || '',
            plant: rawTopRecord.plant || preview?.targetPlant || targetPlant || '',
            bomUsage: rawTopRecord.bomUsage || preview?.targetUsage || '1',
            alternativeBom: rawTopRecord.alternativeBom || rawTopRecord.targetAlternative || preview?.targetAltBom || '1',
            validFrom: rawTopRecord.validFrom || preview?.validFrom || '—',
            description: rawTopRecord.description || preview?.description || preview?.targetDescription || preview?.sourceDescription || '—'
          };

          displayData = [topLevelRecord];
          displaySchema = {
            entityKey: 'bom',
            columns: [
              { name: 'material', label: 'Material', readOnly: true },
              { name: 'plant', label: 'Plant' },
              { name: 'bomUsage', label: 'BOM Usage' },
              { name: 'alternativeBom', label: 'Alternative', aliases: ['targetAlternative', 'alternative', 'altBom'] },
              { name: 'validFrom', label: 'Valid From' },
              { name: 'description', label: 'Description' }
            ]
          };
        }
      }

      // Append result message
      const resultMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'assistant',
        text: formattedReply,
        data: displayData,
        schema: displaySchema,
        entityKey: isCopyBomAction ? 'bom' : (res.entityKey || null),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages((prev) => [...prev, resultMsg]);
      setErrorBanner('');

      // Immediately notify parent if registered
      if (typeof onActionExecuted === 'function') {
        try {
          onActionExecuted();
        } catch (e) {
          console.warn('Error in onActionExecuted callback:', e);
        }
      }
    } catch (err) {
      console.error('Error confirming action:', err);
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, actionStatus: 'failed' } : m))
      );
      setErrorBanner(err.response?.data?.reply || err.message || 'Failed to execute confirmed action.');
    }
  };

  const handleCancelAction = async (msgId, actionId) => {
    try {
      await cancelChatAction(actionId);
    } catch (err) {
      console.warn('Error cancelling action:', err);
    }

    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, actionStatus: 'cancelled' } : m))
    );

    const cancelReplyMsg = {
      id: (Date.now() + 1).toString(),
      sender: 'assistant',
      text: 'Action proposal was cancelled. No records were modified.',
      data: null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages((prev) => [...prev, cancelReplyMsg]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleClearHistory = () => {
    setMessages([INITIAL_GREETING]);
    setErrorBanner('');
  };

  return (
    <div className="sap-card sap-chat-wrapper">
      {/* Chat Header */}
      <div className="sap-chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="sap-chat-bot-icon">
            <Bot size={20} color="#fff" />
          </div>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--sap-text)' }}>
              SAP AI Operations Assistant
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--sap-text-muted)' }}>
              Natural language queries & human-confirmed BOM operations
            </p>
          </div>
        </div>

        <button
          type="button"
          className="sap-btn sap-btn-secondary"
          style={{ height: 32, fontSize: '12px', padding: '0 10px' }}
          onClick={handleClearHistory}
          title="Clear chat conversation"
        >
          <Trash2 size={13} />
          <span>Reset Chat</span>
        </button>
      </div>

      {/* Error Notice Banner */}
      {errorBanner && (
        <div className="sap-alert sap-alert-error" style={{ margin: '12px 20px 0' }}>
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>{errorBanner}</div>
        </div>
      )}

      {/* Message History Feed */}
      <div className="sap-chat-history">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
          return (
            <div
              key={msg.id}
              className={`sap-chat-message-row ${isUser ? 'user-row' : 'assistant-row'}`}
            >
              <div className="sap-chat-avatar">
                {isUser ? <User size={16} color="#0070f2" /> : <Bot size={16} color="#0070f2" />}
              </div>

              <div className="sap-chat-bubble-container">
                <div className={`sap-chat-bubble ${isUser ? 'user-bubble' : 'assistant-bubble'} ${msg.isError ? 'error-bubble' : ''}`}>
                  {isUser ? (
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{msg.text}</p>
                  ) : (
                    <div className="sap-markdown">
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </div>
                  )}
                  <span className="sap-chat-timestamp">{msg.timestamp}</span>
                </div>

                {/* Render Interactive Create BOM Form */}
                {!isUser && msg.formType === 'create_bom' && msg.formStatus === 'active' && (
                  <div style={{ marginTop: 12, width: '100%', maxWidth: '100%' }}>
                    <CreateBomForm
                      onSubmit={(formData) => handleCreateBomSubmit(msg.id, formData)}
                      onCancel={() => handleCreateBomCancel(msg.id)}
                      initialValues={msg.formInitialValues}
                    />
                  </div>
                )}

                {/* Render Interactive Delete BOM Form */}
                {!isUser && msg.formType === 'delete_bom' && msg.formStatus === 'active' && (
                  <div style={{ marginTop: 12, width: '100%', maxWidth: '100%' }}>
                    <DeleteBomForm
                      onSubmit={(formData) => handleDeleteBomSubmit(msg.id, formData)}
                      onCancel={() => handleDeleteBomCancel(msg.id)}
                      initialValues={msg.formInitialValues}
                    />
                  </div>
                )}

                {/* Render Human Confirmation Card for Proposed Write Actions */}
                {!msg.isError && msg.proposedAction && (
                  <div style={{ marginTop: 12, width: '100%', maxWidth: '100%' }}>
                    <ConfirmationCard
                      action={msg.proposedAction}
                      status={msg.actionStatus || 'pending'}
                      onConfirm={(actionId, options) => handleConfirmAction(msg.id, actionId, options)}
                      onCancel={(actionId) => handleCancelAction(msg.id, actionId)}
                    />
                  </div>
                )}

                {/* Render dynamic EntityTable if the tool returned records without error */}
                {!msg.isError && msg.data && msg.data.length > 0 && (
                  <div style={{ marginTop: 12, width: '100%', maxWidth: '100%' }}>
                    <EntityTable
                      schema={msg.schema}
                      data={msg.data}
                      totalCount={msg.data.length}
                      title={
                        msg.entityKey === 'bom' || (msg.data && msg.data[0]?.material && (msg.data[0]?.bomUsage !== undefined || msg.data[0]?.components !== undefined))
                          ? msg.data.length === 1
                            ? 'Results: 1 Bill of Materials'
                            : `Results: ${msg.data.length} Bills of Materials`
                          : `Results: ${msg.data.length} Record(s) Returned`
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="sap-chat-message-row assistant-row">
            <div className="sap-chat-avatar">
              <Bot size={16} color="#0070f2" />
            </div>
            <div className="sap-chat-bubble assistant-bubble" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="sap-spinner sap-spinner-blue" style={{ width: 14, height: 14 }} />
              <span style={{ fontSize: '13px', color: 'var(--sap-text-muted)' }}>
                Processing request...
              </span>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Quick Suggestion Actions (Create BOM & Delete BOM only) */}
      <div className="sap-chat-suggestions">
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--sap-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Sparkles size={12} color="#0070f2" />
          Quick Actions:
        </span>
        <button
          type="button"
          className="sap-chat-suggestion-chip"
          onClick={() => triggerStructuredAction('create_bom')}
          disabled={isLoading}
        >
          <Copy size={13} color="#0070f2" />
          <span>Copy BOM</span>
          <ArrowUpRight size={12} />
        </button>
        <button
          type="button"
          className="sap-chat-suggestion-chip"
          onClick={() => triggerStructuredAction('bulk_bom_copy')}
          disabled={isLoading}
          style={{ background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534' }}
        >
          <FileSpreadsheet size={13} color="#16a34a" />
          <span>Bulk Copy (Excel)</span>
          <ArrowUpRight size={12} />
        </button>
        <button
          type="button"
          className="sap-chat-suggestion-chip chip-danger"
          onClick={() => triggerStructuredAction('delete_bom')}
          disabled={isLoading}
        >
          <Trash2 size={13} color="#bb0000" />
          <span>Delete BOM</span>
          <ArrowUpRight size={12} />
        </button>
      </div>

      {/* Input Area */}
      <div className="sap-chat-input-bar">
        <textarea
          ref={inputRef}
          className="sap-input sap-chat-textarea"
          placeholder="Ask a question or type 'Copy BOM', 'Bulk Copy', 'Delete BOM'... (Press Enter to send, Shift+Enter for new line)"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={1}
        />
        <button
          type="button"
          className="sap-btn sap-btn-primary sap-chat-send-btn"
          onClick={() => handleSendMessage()}
          disabled={isLoading || !inputMessage.trim()}
          title="Send query (Enter)"
        >
          {isLoading ? <span className="sap-spinner" /> : <Send size={16} />}
          <span>Send</span>
        </button>
      </div>

      {/* Bulk BOM Copy Modal Dialog */}
      <BulkBomCopyModal
        isOpen={isBulkModalOpen}
        onClose={() => setIsBulkModalOpen(false)}
        onExecutionComplete={handleBulkExecutionComplete}
      />
    </div>
  );
}
