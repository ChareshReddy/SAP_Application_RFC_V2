import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  FileSpreadsheet,
  Upload,
  Download,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  RefreshCw,
  X,
  Layers,
  Factory,
  Hash,
  ArrowRight,
  ShieldCheck,
  FileCheck
} from 'lucide-react';
import { batchValidateBoms, batchCopyBoms, downloadBomTemplate } from '../services/api';

/**
 * Normalizes headers from Excel spreadsheet into recognized internal keys.
 */
function normalizeRowKeys(rawRow) {
  const normalized = {};

  for (const [key, value] of Object.entries(rawRow)) {
    const k = key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    // Source Material
    if (k.includes('srcmat') || k.includes('sourcemat') || (k.includes('source') && k.includes('mat')) || k === 'matnr') {
      normalized.sourceMaterial = String(value || '').trim().toUpperCase();
    }
    // Source Plant
    else if (k.includes('srcplant') || k.includes('sourceplant') || (k.includes('source') && k.includes('plant')) || (k.includes('source') && k.includes('werks'))) {
      normalized.sourcePlant = String(value || '').trim().toUpperCase();
    }
    // Source Usage
    else if (k.includes('srcuse') || k.includes('srcusage') || (k.includes('source') && k.includes('use')) || (k.includes('source') && k.includes('usage')) || (k.includes('source') && k.includes('stlan'))) {
      normalized.sourceUsage = String(value || '1').trim();
    }
    // Source Alternative
    else if (k.includes('srcalt') || k.includes('sourcealt') || (k.includes('source') && k.includes('alt')) || (k.includes('source') && k.includes('stlal'))) {
      normalized.sourceAltBom = String(value || '1').trim();
    }
    // Target Material
    else if (k.includes('tgtmat') || k.includes('targetmat') || (k.includes('target') && k.includes('mat'))) {
      normalized.targetMaterial = String(value || '').trim().toUpperCase();
    }
    // Target Plant
    else if (k.includes('tgtplant') || k.includes('targetplant') || (k.includes('target') && k.includes('plant')) || (k.includes('target') && k.includes('werks'))) {
      normalized.targetPlant = String(value || '').trim().toUpperCase();
    }
    // Target Usage
    else if (k.includes('tgtuse') || k.includes('tgtusage') || (k.includes('target') && k.includes('use')) || (k.includes('target') && k.includes('usage')) || (k.includes('target') && k.includes('stlan'))) {
      normalized.targetUsage = String(value || '1').trim();
    }
    // Target Alternative
    else if (k.includes('tgtalt') || k.includes('targetalt') || (k.includes('target') && k.includes('alt')) || (k.includes('target') && k.includes('stlal'))) {
      normalized.targetAltBom = String(value || '').trim();
    }
  }

  // Fallbacks: if target material is missing, default to source material
  if (!normalized.targetMaterial && normalized.sourceMaterial) {
    normalized.targetMaterial = normalized.sourceMaterial;
  }
  if (!normalized.sourceUsage) normalized.sourceUsage = '1';
  if (!normalized.targetUsage) normalized.targetUsage = '1';
  if (!normalized.sourceAltBom) normalized.sourceAltBom = '1';

  return normalized;
}

export default function BulkBomCopyModal({ isOpen, onClose, onExecutionComplete }) {
  const [file, setFile] = useState(null);
  const [parsedRows, setParsedRows] = useState([]);
  const [parseError, setParseError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Validation phase state
  const [isValidating, setIsValidating] = useState(false);
  const [validationReport, setValidationReport] = useState(null);

  // Execution phase state
  const [isExecuting, setIsExecuting] = useState(false);
  const [skipErrors, setSkipErrors] = useState(true);
  const [copyHierarchy, setCopyHierarchy] = useState(true);
  const [executionReport, setExecutionReport] = useState(null);
  const [activeStep, setActiveStep] = useState(1); // 1: Upload, 2: Validate, 3: Execute/Results

  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const resetAll = () => {
    setFile(null);
    setParsedRows([]);
    setParseError('');
    setValidationReport(null);
    setIsExecuting(false);
    setExecutionReport(null);
    setActiveStep(1);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    if (isExecuting) {
      if (!window.confirm('Batch copy is currently in progress. Are you sure you want to close?')) {
        return;
      }
    }
    resetAll();
    onClose();
  };

  const processFile = (fileObj) => {
    setParseError('');
    setValidationReport(null);
    setExecutionReport(null);

    if (!fileObj) return;

    const validExts = ['.xlsx', '.xls', '.csv'];
    const lowerName = fileObj.name.toLowerCase();
    const isValidExt = validExts.some((ext) => lowerName.endsWith(ext));

    if (!isValidExt) {
      setParseError('Please upload an Excel file (.xlsx, .xls) or CSV file.');
      return;
    }

    setFile(fileObj);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          setParseError('The uploaded workbook contains no sheets.');
          return;
        }

        const sheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (!rawJson || rawJson.length === 0) {
          setParseError('The Excel sheet contains no data rows.');
          return;
        }

        const normalized = rawJson
          .map((row, index) => {
            const norm = normalizeRowKeys(row);
            return {
              id: index + 1,
              ...norm,
              status: 'PENDING',
              message: 'Not validated yet'
            };
          })
          .filter((r) => r.sourceMaterial || r.sourcePlant || r.targetPlant || r.targetAltBom);

        if (normalized.length === 0) {
          setParseError('Could not recognize any valid BOM columns. Please use the sample template.');
          return;
        }

        setParsedRows(normalized);
        setActiveStep(1);
      } catch (err) {
        console.error('Failed to parse Excel file:', err);
        setParseError(`Failed to parse file: ${err.message}`);
      }
    };
    reader.readAsArrayBuffer(fileObj);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadBomTemplate();
    } catch (err) {
      // Fallback: generate template client-side if server download fails
      console.warn('Backend template download failed, generating client-side fallback:', err.message);
      const sample = [
        {
          'Source Material': 'A1BH0214C',
          'Source Plant': '1012',
          'Source BOM Usage': '1',
          'Source Alternative': '1',
          'Target Material': 'A1BH0214C',
          'Target Plant': '1001',
          'Target BOM Usage': '1',
          'Target Alternative': '12'
        },
        {
          'Source Material': 'A1BH0214C',
          'Source Plant': '1012',
          'Source BOM Usage': '1',
          'Source Alternative': '2',
          'Target Material': 'A1BH0214C',
          'Target Plant': '1001',
          'Target BOM Usage': '1',
          'Target Alternative': '13'
        }
      ];
      const ws = XLSX.utils.json_to_sheet(sample);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'BOM_Template');
      XLSX.writeFile(wb, 'BOM_Copy_Template.xlsx');
    }
  };

  // Run SAP Pre-flight Validation
  const handleValidateWithSap = async () => {
    if (parsedRows.length === 0) return;
    setIsValidating(true);
    setParseError('');

    try {
      const response = await batchValidateBoms(parsedRows);
      if (response.success) {
        setValidationReport(response);
        setActiveStep(2);

        // Update parsed rows with validation details
        const resMap = new Map((response.results || []).map((r) => [r.id, r]));
        setParsedRows((prev) =>
          prev.map((row) => {
            const match = resMap.get(row.id);
            if (match) {
              return {
                ...row,
                status: match.status,
                message: match.message,
                componentCount: match.componentCount || 0
              };
            }
            return row;
          })
        );
      } else {
        setParseError(response.message || 'Validation request failed.');
      }
    } catch (err) {
      console.error('Validation error:', err);
      setParseError(err.response?.data?.message || err.message || 'Validation failed.');
    } finally {
      setIsValidating(false);
    }
  };

  // Execute Batch Copy
  const handleExecuteBatchCopy = async () => {
    const executableRows = parsedRows.filter((r) => r.status === 'VALID' || r.status === 'WARNING');
    if (executableRows.length === 0) {
      alert('No valid rows available to execute.');
      return;
    }

    const hasWarnings = parsedRows.some((r) => r.status === 'WARNING');
    const warningNotice = hasWarnings
      ? '\n\n⚠️ Note: Some rows have WARNINGS (target alternative may already exist and conflict).'
      : '';

    const confirmMsg = `Are you sure you want to copy ${executableRows.length} Bill of Materials in SAP?${warningNotice}\n\nOperation will be executed sequentially via high-speed SAP RFC.`;
    if (!window.confirm(confirmMsg)) {
      return;
    }

    setIsExecuting(true);
    setActiveStep(3);

    try {
      const response = await batchCopyBoms(parsedRows, { skipErrors, copyHierarchy });
      setExecutionReport(response);

      if (response.success) {
        const resMap = new Map((response.results || []).map((r) => [r.id, r]));
        setParsedRows((prev) =>
          prev.map((row) => {
            const match = resMap.get(row.id);
            if (match) {
              return {
                ...row,
                status: match.success ? 'SUCCESS' : 'FAILED',
                message: match.message,
                bomNumber: match.bomNumber || '',
                totalLevels: match.totalLevels || 1,
                totalBoms: match.totalBoms || 1
              };
            }
            return row;
          })
        );

        if (onExecutionComplete) {
          onExecutionComplete(response);
        }
      } else {
        setParseError(response.message || 'Batch execution stopped with errors.');
      }
    } catch (err) {
      console.error('Execution error:', err);
      setParseError(err.response?.data?.message || err.message || 'Execution failed.');
    } finally {
      setIsExecuting(false);
    }
  };

  // Export Results to Excel
  const handleExportResults = () => {
    if (parsedRows.length === 0) return;

    const exportData = parsedRows.map((r, i) => ({
      'Row #': i + 1,
      'Source Material': r.sourceMaterial,
      'Source Plant': r.sourcePlant,
      'Source Usage': r.sourceUsage,
      'Source Alt BOM': r.sourceAltBom,
      'Target Material': r.targetMaterial,
      'Target Plant': r.targetPlant,
      'Target Usage': r.targetUsage,
      'Target Alt BOM': r.targetAltBom,
      'Components': r.componentCount || '-',
      'Hierarchy Levels': r.totalLevels || 1,
      'Total BOMs Created': r.totalBoms || 1,
      'Execution Status': r.status,
      'SAP BOM Number': r.bomNumber || '-',
      'SAP Message': r.message
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    ws['!cols'] = [
      { wch: 8 },
      { wch: 16 },
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
      { wch: 16 },
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
      { wch: 12 },
      { wch: 16 },
      { wch: 18 },
      { wch: 16 },
      { wch: 16 },
      { wch: 45 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Batch_Copy_Results');
    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `SAP_BOM_Batch_Copy_Report_${timestamp}.xlsx`);
  };

  const validCount = parsedRows.filter((r) => r.status === 'VALID' || r.status === 'SUCCESS').length;
  const warningCount = parsedRows.filter((r) => r.status === 'WARNING').length;
  const errorCount = parsedRows.filter((r) => r.status === 'ERROR' || r.status === 'FAILED').length;

  return (
    <div className="sap-bulk-modal-overlay">
      <div className="sap-bulk-modal-container">
        {/* Header */}
        <div className="sap-bulk-modal-header">
          <div className="sap-bulk-modal-title">
            <div className="sap-bulk-icon-badge">
              <FileSpreadsheet size={22} color="#0070f2" />
            </div>
            <div>
              <h3>Bulk BOM Copy via Excel</h3>
              <p>Upload a spreadsheet to validate and copy multiple Bills of Materials simultaneously via SAP RFC.</p>
            </div>
          </div>
          <button
            type="button"
            className="sap-modal-close-btn"
            onClick={handleClose}
            title="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Workflow Steps Indicator */}
        <div className="sap-bulk-steps-bar">
          <div className={`sap-bulk-step ${activeStep >= 1 ? 'active' : ''}`}>
            <span className="step-num">1</span>
            <span>Upload File</span>
          </div>
          <div className="step-arrow"><ArrowRight size={14} /></div>
          <div className={`sap-bulk-step ${activeStep >= 2 ? 'active' : ''}`}>
            <span className="step-num">2</span>
            <span>SAP Pre-flight Validation</span>
          </div>
          <div className="step-arrow"><ArrowRight size={14} /></div>
          <div className={`sap-bulk-step ${activeStep >= 3 ? 'active' : ''}`}>
            <span className="step-num">3</span>
            <span>Sequential Execution</span>
          </div>
        </div>

        {/* Error Notification */}
        {parseError && (
          <div className="sap-form-alert sap-form-alert-error" style={{ margin: '12px 24px 0' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>{parseError}</span>
          </div>
        )}

        {/* Modal Body */}
        <div className="sap-bulk-modal-body">
          {/* Step 1: Upload Dropzone if no file or preview */}
          {parsedRows.length === 0 ? (
            <div className="sap-dropzone-container">
              <div
                className={`sap-file-dropzone ${isDragging ? 'dragging' : ''}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  accept=".xlsx, .xls, .csv"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      processFile(e.target.files[0]);
                    }
                  }}
                />
                <div className="dropzone-icon">
                  <Upload size={36} color="#0070f2" />
                </div>
                <h4>Drag & drop Excel or CSV file here</h4>
                <p>Supports .xlsx, .xls, and .csv with Source & Target BOM columns</p>
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button
                    type="button"
                    className="sap-btn sap-btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload size={14} />
                    <span>Browse Files</span>
                  </button>
                  <button
                    type="button"
                    className="sap-btn sap-btn-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownloadTemplate();
                    }}
                  >
                    <Download size={14} />
                    <span>Download Excel Template</span>
                  </button>
                </div>
              </div>

              {/* Template Helper Card */}
              <div className="sap-template-guide-card">
                <h5>Required Excel Columns:</h5>
                <div className="sap-columns-pill-grid">
                  <span className="col-pill required">Source Material</span>
                  <span className="col-pill required">Source Plant</span>
                  <span className="col-pill optional">Source BOM Usage (def: 1)</span>
                  <span className="col-pill required">Source Alternative</span>
                  <span className="col-pill optional">Target Material (def: Source)</span>
                  <span className="col-pill required">Target Plant</span>
                  <span className="col-pill optional">Target BOM Usage (def: 1)</span>
                  <span className="col-pill required">Target Alternative</span>
                </div>
              </div>
            </div>
          ) : (
            /* Step 2 & 3: File Parsed - Show Table & Actions */
            <div className="sap-bulk-table-view">
              {/* File Info Bar */}
              <div className="sap-bulk-file-info-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <FileCheck size={18} color="#107e3e" />
                  <span style={{ fontWeight: 600, color: 'var(--sap-text)' }}>{file?.name}</span>
                  <span className="sap-badge-count">{parsedRows.length} rows loaded</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="sap-btn sap-btn-ghost sap-btn-sm"
                    onClick={handleDownloadTemplate}
                    title="Download template"
                  >
                    <Download size={13} />
                    <span>Template</span>
                  </button>
                  {!isExecuting && (
                    <button
                      type="button"
                      className="sap-btn sap-btn-ghost sap-btn-sm"
                      onClick={resetAll}
                    >
                      <RefreshCw size={13} />
                      <span>Change File</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Summary Counter Badges */}
              {validationReport && (
                <div className="sap-bulk-status-summary">
                  <div className="status-stat valid">
                    <CheckCircle2 size={16} />
                    <span>{validCount} Ready</span>
                  </div>
                  <div className="status-stat warning">
                    <AlertTriangle size={16} />
                    <span>{warningCount} Warnings</span>
                  </div>
                  <div className="status-stat error">
                    <XCircle size={16} />
                    <span>{errorCount} Errors</span>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
                    <label style={{ fontSize: '12px', color: '#166534', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: '#dcfce7', padding: '3px 8px', borderRadius: 5 }}>
                      <input
                        type="checkbox"
                        checked={copyHierarchy}
                        onChange={(e) => setCopyHierarchy(e.target.checked)}
                        disabled={isExecuting}
                      />
                      <span>Copy Full Hierarchy (All Sub-assemblies)</span>
                    </label>
                    <label style={{ fontSize: '12px', color: 'var(--sap-text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={skipErrors}
                        onChange={(e) => setSkipErrors(e.target.checked)}
                        disabled={isExecuting}
                      />
                      Skip errors
                    </label>
                  </div>
                </div>
              )}

              {/* Grid Preview Table */}
              <div className="sap-bulk-grid-container">
                <table className="sap-bulk-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th>Source BOM</th>
                      <th>Target BOM</th>
                      <th style={{ width: 100 }}>Components</th>
                      <th style={{ width: 120 }}>Status</th>
                      <th>Diagnostic / Result Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.map((row, idx) => {
                      const isRowValid = row.status === 'VALID' || row.status === 'SUCCESS';
                      const isRowWarn = row.status === 'WARNING';
                      const isRowError = row.status === 'ERROR' || row.status === 'FAILED';

                      return (
                        <tr key={row.id || idx} className={`row-status-${row.status.toLowerCase()}`}>
                          <td style={{ fontWeight: 600, color: 'var(--sap-text-muted)' }}>{idx + 1}</td>
                          <td>
                            <div className="bom-identity-cell">
                              <span className="mat-pill">{row.sourceMaterial}</span>
                              <span className="sub-detail">Plant: <strong>{row.sourcePlant}</strong> | Usage: {row.sourceUsage} | Alt: <strong>{row.sourceAltBom}</strong></span>
                            </div>
                          </td>
                          <td>
                            <div className="bom-identity-cell">
                              <span className="mat-pill">{row.targetMaterial}</span>
                              <span className="sub-detail">Plant: <strong>{row.targetPlant}</strong> | Usage: {row.targetUsage} | Alt: <strong style={{ color: '#0070f2' }}>{row.targetAltBom}</strong></span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {row.componentCount !== undefined && row.componentCount > 0 ? (
                              <span className="comp-count-badge">{row.componentCount} items</span>
                            ) : (
                              <span style={{ color: '#94a3b8' }}>-</span>
                            )}
                          </td>
                          <td>
                            <span className={`sap-status-chip chip-${row.status.toLowerCase()}`}>
                              {isRowValid && <CheckCircle2 size={12} />}
                              {isRowWarn && <AlertTriangle size={12} />}
                              {isRowError && <XCircle size={12} />}
                              {row.status === 'PENDING' && 'Pending'}
                              {row.status === 'VALID' && 'Ready'}
                              {row.status === 'WARNING' && 'Warning'}
                              {row.status === 'ERROR' && 'Error'}
                              {row.status === 'SUCCESS' && 'Copied'}
                              {row.status === 'FAILED' && 'Failed'}
                            </span>
                          </td>
                          <td>
                            <div className="message-cell">
                              <span className="cell-msg-text">{row.message}</span>
                              {row.bomNumber && (
                                <span className="bom-num-tag">SAP BOM: {row.bomNumber}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="sap-bulk-modal-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {executionReport && (
              <button
                type="button"
                className="sap-btn sap-btn-secondary"
                onClick={handleExportResults}
              >
                <Download size={15} />
                <span>Export Report to Excel</span>
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="sap-btn sap-btn-ghost"
              onClick={handleClose}
              disabled={isExecuting}
            >
              {executionReport ? 'Close' : 'Cancel'}
            </button>

            {parsedRows.length > 0 && !validationReport && !executionReport && (
              <button
                type="button"
                className="sap-btn sap-btn-primary"
                onClick={handleValidateWithSap}
                disabled={isValidating}
              >
                {isValidating ? (
                  <>
                    <span className="sap-spinner" />
                    <span>Validating with SAP...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck size={16} />
                    <span>Validate Rows with SAP</span>
                  </>
                )}
              </button>
            )}

            {validationReport && !executionReport && (
              <button
                type="button"
                className="sap-btn sap-btn-primary"
                onClick={handleExecuteBatchCopy}
                disabled={isExecuting || (validCount === 0 && warningCount === 0)}
              >
                {isExecuting ? (
                  <>
                    <span className="sap-spinner" />
                    <span>Executing Sequential RFC Copy...</span>
                  </>
                ) : (
                  <>
                    <Play size={16} />
                    <span>Execute Batch Copy ({validCount + warningCount} Items)</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
