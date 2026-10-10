import express from 'express';
import axios from 'axios';
import {
  getEntityData,
  getEntityRecordById,
  updateEntityRecord,
  createEntityRecord,
  deleteEntityRecord,
  getBackgroundJobLog,
  retryBackgroundJob,
  reprocessIdoc,
  retriggerInterface,
  getMockDataCache,
  releasePurchaseOrder,
  postFinancialDocument,
  changeMasterData
} from '../services/sapClient.js';
import { classifyError, recordErrorOccurrence } from '../config/errorKnowledgeBase.js';
import { RISK_LEVELS, getRiskLevel, requiresChangeReason } from '../config/riskLevels.js';
import { SYSTEM_REGISTRY, DEFAULT_SYSTEM, isValidSystemKey } from '../config/systemRegistry.js';
import { sessionStore } from '../services/sessionStore.js';
import { decryptCredentials } from '../services/encryption.js';
import { pendingActionStore } from '../services/pendingActions.js';
import { auditLogger } from '../services/auditLog.js';
import {
  copyBomViaGui,
  copyBomHierarchyWithRepair,
  deleteBomViaGui,
  verifyBomInCs03,
  discoverBomHierarchy,
  resolveNextAvailableAlternative,
  formatHierarchyTree,
  verifyHierarchyStructure,
  checkBomSubDependencies,
  ensureSapSession,
  getActiveSapUser,
  getSelectedSapUser,
  getSelectedSapSessionId
} from '../services/sapGuiClient.js';
import {
  rfcReadBom,
  rfcValidateSourceBom,
  rfcCreateBom,
  rfcDeleteBom,
  rfcCopyBom
} from '../services/sapRfcClient.js';
import { checkMaterialMaintenance } from '../services/materialCheck.js';
import {
  ENTITY_REGISTRY,
  getEntitySchema,
  resolveEntityKey,
  getColumnByName,
  getRecordColumnValue,
  isValidEntityKey,
  isValidColumn,
  isValidOperator,
  getSystemPromptEntitiesDescription,
  validateCreateFields,
  validateUpdateChanges
} from '../config/entitySchemas/index.js';

const router = express.Router();

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const registeredEntityKeys = Object.keys(ENTITY_REGISTRY);

/**
 * Extracts Copy BOM parameters (material, sourcePlant, targetPlant) from natural language text.
 */
export function extractCopyBomParamsFromText(msg) {
  if (!msg || typeof msg !== 'string') return {};

  const matMatch = msg.match(/(?:material\s+|for\s+material\s+|for\s+)([A-Za-z0-9_-]+)/i);
  let mat = matMatch ? matMatch[1].trim() : '';
  if (/^(the|a|an|plant|bom|new|existing)$/i.test(mat)) mat = '';

  const tgtMatch = msg.match(/(?:to\s+plant|in\s+plant|into\s+plant)\s+([A-Za-z0-9_-]+)/i) ||
                   msg.match(/to\s+([0-9]{4})/i);
  let tgtPlant = tgtMatch ? tgtMatch[1].trim() : '';
  if (/^(plant|the|a|new)$/i.test(tgtPlant)) tgtPlant = '';

  const srcMatch = msg.match(/from\s+(?:(?:the\s+)?existing\s+BOM\s+from\s+|plant\s+)?([A-Za-z0-9_-]+)/i);
  let srcPlant = srcMatch ? srcMatch[1].trim() : '';
  if (/^(plant|the|a|existing)$/i.test(srcPlant)) srcPlant = '';

  return { material: mat, sourcePlant: srcPlant, targetPlant: tgtPlant };
}

/**
 * Pre-validates Copy-From BOM parameters before proposing or executing copy actions.
 * Rules enforced:
 * - Rule 7: Prevent copying when source and target refer to the same BOM
 * - Rule 1, 2, 3: Pre-validate SOURCE BOM existence in CS03
 * - Rule 8: If source lookup is unavailable, stop rather than guessing
 *
 * @param {object} params
 * @returns {Promise<{ valid: boolean, code?: string, message?: string, cleanParams?: object }>}
 */
export async function validateCopyBomParameters({
  sourceMaterial,
  sourcePlant,
  sourceUsage = '1',
  sourceAltBom = '',
  targetMaterial,
  targetPlant,
  targetUsage = '1',
  targetAltBom = ''
}) {
  const cleanSrcMat = String(sourceMaterial || '').trim();
  const cleanSrcPlant = String(sourcePlant || '').trim();
  const cleanSrcUsage = String(sourceUsage || '1').trim();
  const cleanSrcAlt = String(sourceAltBom || '').trim();

  const cleanTgtMat = String(targetMaterial || '').trim();
  const cleanTgtPlant = String(targetPlant || '').trim();
  const cleanTgtUsage = String(targetUsage || '1').trim();
  const cleanTgtAlt = String(targetAltBom || '').trim();

  if (!cleanSrcMat || !cleanSrcPlant || !cleanTgtMat || !cleanTgtPlant) {
    return {
      valid: false,
      code: 'MISSING_FIELDS',
      message: 'To propose copying a BOM, please provide the source material, source plant, target material, and target plant.'
    };
  }

  // Rule 7: Prevent copying when source and target refer to the same BOM
  const sameMat = cleanSrcMat.toUpperCase() === cleanTgtMat.toUpperCase();
  const samePlant = cleanSrcPlant === cleanTgtPlant;
  const sameUsage = cleanSrcUsage === cleanTgtUsage;
  const sameAlt = (!cleanSrcAlt && !cleanTgtAlt) || (cleanSrcAlt === cleanTgtAlt);

  if (sameMat && samePlant && sameUsage && sameAlt) {
    return {
      valid: false,
      code: 'SAME_SOURCE_TARGET',
      message: 'Source and target BOM are the same. A BOM cannot be copied onto itself.'
    };
  }

  const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';

  // Preflight check for SAP session availability (only required for GUI scripting)
  if (!useRfc) {
    const preflight = await ensureSapSession();
    if (!preflight.ok) {
      return {
        valid: false,
        code: preflight.status === 'SERVER_UNAVAILABLE' ? 'SAP_SERVER_UNAVAILABLE' : (preflight.code || 'SAP_SESSION_NOT_FOUND'),
        message: preflight.message
      };
    }
  }

  // Rule 1, 2, 3: Pre-validate SOURCE BOM existence via RFC or CS03
  let sourceCheck;
  try {
    sourceCheck = useRfc
      ? await rfcReadBom({
          material: cleanSrcMat,
          plant: cleanSrcPlant,
          bomUsage: cleanSrcUsage,
          alternativeBom: cleanSrcAlt
        })
      : await verifyBomInCs03({
          material: cleanSrcMat,
          plant: cleanSrcPlant,
          bomUsage: cleanSrcUsage,
          alternativeBom: cleanSrcAlt
        });
  } catch (err) {
    return {
      valid: false,
      code: 'SOURCE_LOOKUP_UNAVAILABLE',
      message: `Cannot verify source BOM: ${err.message || 'Operation failed'}. Workflow stopped.`
    };
  }

  if (!sourceCheck.success) {
    return {
      valid: false,
      code: sourceCheck.code || 'SOURCE_LOOKUP_UNAVAILABLE',
      message: sourceCheck.message || 'Cannot verify source BOM: lookup failed. Workflow stopped.'
    };
  }

  const bomExists = sourceCheck.bomExists ?? sourceCheck.exists;
  if (!bomExists) {
    return {
      valid: false,
      code: 'SOURCE_BOM_NOT_FOUND',
      message: sourceCheck.message && sourceCheck.message.includes('Alternative')
        ? `Cannot copy BOM: ${sourceCheck.message}`
        : `Cannot copy BOM: No BOM exists for material ${cleanSrcMat} in plant ${cleanSrcPlant} with BOM usage ${cleanSrcUsage}.`
    };
  }

  // Do NOT scan target hierarchy pre-flight (target is inspected strictly during execution when creating alternatives)
  return {
    valid: true,
    cleanParams: {
      sourceMaterial: cleanSrcMat,
      sourcePlant: cleanSrcPlant,
      sourceUsage: cleanSrcUsage,
      sourceAltBom: cleanSrcAlt,
      targetMaterial: cleanTgtMat,
      targetPlant: cleanTgtPlant,
      targetUsage: cleanTgtUsage,
      targetAltBom: cleanTgtAlt,
      sourceComponents: sourceCheck.components || []
    },
    availableAlternatives: sourceCheck.availableAlternatives || [],
    hierarchy: null,
    copyOrder: [],
    subBomDependencies: {
      mainBom: {
        material: cleanTgtMat,
        sourcePlant: cleanSrcPlant,
        targetPlant: cleanTgtPlant,
        bomUsage: cleanTgtUsage,
        alternativeBom: cleanTgtAlt || '1',
        componentCount: sourceCheck.componentCount || 0
      },
      missingSubBoms: [],
      existingSubBoms: [],
      unextendedMaterials: [],
      totalBomsMainOnly: 1,
      totalBomsWithSub: 1
    }
  };
}

// Generic Tool definitions for any registered SAP entity
export const TOOLS = [
  // 1. Generic Read Tool
  {
    type: 'function',
    function: {
      name: 'get_entity_data',
      description: 'Fetches SAP entity records for READ-ONLY queries (search, view, list, browse). Call this whenever the user asks to view or search records, or confirms an offer to pull/show records (e.g. "show", "yes"). If no specific filter was requested, omit filters or provide an empty filters array [] to return default records. Do NOT call this if the user provided a specific record ID and wants to change, update, create, or delete.',
      parameters: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            enum: registeredEntityKeys,
            description: `The target SAP entity: ${registeredEntityKeys.join(', ')}`
          },
          filters: {
            type: 'array',
            description: 'Optional list of filter conditions to apply. Each filter targets one column of the entity.',
            items: {
              type: 'object',
              properties: {
                column: {
                  type: 'string',
                  description: 'Exact column name defined in the entity schema.'
                },
                operator: {
                  type: 'string',
                  enum: ['eq', 'ge', 'le', 'contains']
                },
                value: {
                  type: 'string'
                }
              },
              required: ['column', 'operator', 'value']
            }
          },
          top: { type: 'number', description: 'Maximum records to return (default 50)' },
          skip: { type: 'number', description: 'Records to skip for pagination (default 0)' }
        },
        required: ['entityKey']
      }
    }
  },
  // 2. Generic Update Proposal Tool
  {
    type: 'function',
    function: {
      name: 'propose_update_entity_record',
      description: 'Proposes an update to an existing SAP entity record. Call this DIRECTLY whenever the user requests to change, update, modify, set, correct, or fix field(s) on a specific record (e.g. by ID). Does NOT execute changes directly — creates a dry-run preview requiring human confirmation in the UI. Only editable fields may be changed.',
      parameters: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            enum: registeredEntityKeys,
            description: 'The target SAP entity key.'
          },
          recordId: {
            type: 'string',
            description: 'The exact primary key ID of the record to update.'
          },
          changes: {
            type: 'object',
            description: 'Key-value map of editable column names to new values.'
          }
        },
        required: ['entityKey', 'recordId', 'changes']
      }
    }
  },
  // 3. Generic Create Proposal Tool
  {
    type: 'function',
    function: {
      name: 'propose_create_entity_record',
      description: 'Proposes creating a new SAP entity record. Does NOT execute directly — creates a preview requiring human confirmation. Required fields defined in entity schema must be provided (e.g. for BOM: material, plant, bomUsage, components). If required fields are missing, the system prompts the user to provide them.',
      parameters: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            enum: registeredEntityKeys,
            description: 'The target SAP entity key.'
          },
          fields: {
            type: 'object',
            description: 'Field values for the new record matching the entity schema.'
          }
        },
        required: ['entityKey', 'fields']
      }
    }
  },
  // 3b. BOM Copy Proposal Tool (CS01 Automation)
  {
    type: 'function',
    function: {
      name: 'propose_copy_bom',
      description: 'Proposes creating a new Bill of Materials (BOM) in SAP by copying from an existing source/reference BOM via SAP GUI automation (CS01 Copy-From). The system verifies the source BOM exists in CS03 and ensures source and target are not identical before proposing. Does NOT execute directly — creates a preview requiring human confirmation.',
      parameters: {
        type: 'object',
        properties: {
          sourceMaterial: {
            type: 'string',
            description: 'Material number of the source/reference BOM to copy from (e.g. A1BH0214C).'
          },
          sourcePlant: {
            type: 'string',
            description: 'Plant code of the source/reference BOM (e.g. 1012).'
          },
          sourceUsage: {
            type: 'string',
            description: 'BOM Usage of the source BOM (default "1" for Production).'
          },
          targetMaterial: {
            type: 'string',
            description: 'Material number of the target BOM to create (e.g. A1BH0214C).'
          },
          targetPlant: {
            type: 'string',
            description: 'Plant code where the new BOM should be created (e.g. 1001).'
          },
          targetUsage: {
            type: 'string',
            description: 'BOM Usage for the new BOM (default "1" for Production).'
          },
          sourceAltBom: {
            type: 'string',
            description: 'Optional alternative BOM of source (e.g. 1).'
          },
          targetAltBom: {
            type: 'string',
            description: 'Optional alternative BOM of target.'
          },
          validFrom: {
            type: 'string',
            description: 'Optional valid-from date for the new BOM.'
          }
        },
        required: ['sourceMaterial', 'sourcePlant', 'targetMaterial', 'targetPlant']
      }
    }
  },
  // 3c. BOM Delete Proposal Tool (ZBOM_COPY Automation)
  {
    type: 'function',
    function: {
      name: 'propose_delete_bom',
      description: 'Proposes deleting a Bill of Materials (BOM) or specific Alternative BOM in SAP via SAP GUI automation (transaction ZBOM_COPY). Does NOT check or validate beforehand via OData or get_entity_data; the SAP GUI automation handles execution and verification in CS03 directly. Does NOT execute directly — creates a destructive action preview card requiring explicit human confirmation.',
      parameters: {
        type: 'object',
        properties: {
          material: {
            type: 'string',
            description: 'Material number of the BOM to delete (e.g. A1BH0214C).'
          },
          plant: {
            type: 'string',
            description: 'Plant code of the BOM (e.g. 1001).'
          },
          alternativeBom: {
            type: 'string',
            description: 'Alternative BOM number to delete (e.g. 2).'
          },
          bomUsage: {
            type: 'string',
            description: 'BOM Usage (default "1" for Production).'
          }
        },
        required: ['material', 'plant', 'alternativeBom']
      }
    }
  },
  // 4. Generic Delete Proposal Tool
  {
    type: 'function',
    function: {
      name: 'propose_delete_entity_record',
      description: 'Proposes deleting an existing SAP entity record. Does NOT execute directly — creates a preview requiring human confirmation.',
      parameters: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            enum: registeredEntityKeys,
            description: 'The target SAP entity key.'
          },
          recordId: {
            type: 'string',
            description: 'The exact primary key ID of the record to delete.'
          }
        },
        required: ['entityKey', 'recordId']
      }
    }
  },
  // 5. Protected Execution Tool
  {
    type: 'function',
    function: {
      name: 'execute_confirmed_action',
      description: 'FORBIDDEN TO CALL DIRECTLY: Writes can ONLY be executed when the human user clicks the Confirm button in the UI. Never call this tool.',
      parameters: {
        type: 'object',
        properties: {
          actionId: {
            type: 'string',
            description: 'The pending actionId to execute.'
          }
        },
        required: ['actionId']
      }
    }
  },
  // --- SAP Operations Agent Tools (Job Monitoring) ---
  // 6. Check Failed Jobs
  {
    type: 'function',
    function: {
      name: 'check_failed_jobs',
      description: 'Checks and lists all failed SAP background jobs (status CANCELLED) requiring operational inspection.',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: 'Maximum failed jobs to return (default 50)' }
        }
      }
    }
  },
  // 7. Read Job Log
  {
    type: 'function',
    function: {
      name: 'read_job_log',
      description: 'Reads the execution and error log messages for a specific SAP background job.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The exact jobId of the background job (e.g. JOB_1001)' }
        },
        required: ['jobId']
      }
    }
  },
  // 8. Diagnose Job Failure
  {
    type: 'function',
    function: {
      name: 'diagnose_job_failure',
      description: 'Analyzes a failed background job log, diagnoses the root cause against the operations runbook catalogue, and classifies it into category, recommendedAction (RETRY vs ESCALATE), and risk level.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The jobId or jobName to diagnose (e.g. JOB_1001 or Z_INVOICE_BILLING_RUN)' }
        },
        required: ['jobId']
      }
    }
  },
  // 9. Propose Retry Job
  {
    type: 'function',
    function: {
      name: 'propose_retry_job',
      description: 'Proposes an automated retry for a failed background job. Only valid for recoverable errors (RETRY recommendation, Risk Level <= 2). Does NOT execute directly — creates a dry-run preview requiring human confirmation. Strictly rejected if diagnosis requires escalation.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The exact jobId of the cancelled job to retry (e.g. JOB_1001)' }
        },
        required: ['jobId']
      }
    }
  },
  // --- SAP Operations Agent Tools (IDoc Monitoring) ---
  // 10. Check Failed IDocs
  {
    type: 'function',
    function: {
      name: 'check_failed_idocs',
      description: 'Checks and lists all failed SAP IDocs (status 51-Error) requiring operational inspection.',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: 'Maximum failed IDocs to return (default 50)' }
        }
      }
    }
  },
  // 11. Read IDoc Detail
  {
    type: 'function',
    function: {
      name: 'read_idoc_detail',
      description: 'Reads complete details, status, and error segments for a specific SAP IDoc by idocNumber.',
      parameters: {
        type: 'object',
        properties: {
          idocNumber: { type: 'string', description: 'The exact idocNumber (e.g. 0000000000109201)' }
        },
        required: ['idocNumber']
      }
    }
  },
  // 12. Diagnose IDoc Failure
  {
    type: 'function',
    function: {
      name: 'diagnose_idoc_failure',
      description: 'Analyzes a failed IDoc error log, diagnoses the root cause against the operations runbook catalogue, and classifies it into category, recommendedAction (RETRY vs ESCALATE), and risk level.',
      parameters: {
        type: 'object',
        properties: {
          idocNumber: { type: 'string', description: 'The exact idocNumber to diagnose (e.g. 0000000000109201)' }
        },
        required: ['idocNumber']
      }
    }
  },
  // 13. Propose Reprocess IDoc
  {
    type: 'function',
    function: {
      name: 'propose_reprocess_idoc',
      description: 'Proposes reprocessing a failed IDoc. Only valid for recoverable errors (RETRY recommendation, Risk Level <= 2). Does NOT execute directly — creates a dry-run preview requiring human confirmation in the UI. Strictly rejected if diagnosis requires escalation.',
      parameters: {
        type: 'object',
        properties: {
          idocNumber: { type: 'string', description: 'The exact idocNumber to reprocess (e.g. 0000000000109201)' }
        },
        required: ['idocNumber']
      }
    }
  },
  // --- SAP Operations Agent Tools (Application Logs) ---
  // 14. Check Application Logs
  {
    type: 'function',
    function: {
      name: 'check_application_logs',
      description: 'Inspects SAP SLG1 application logs. Can filter by severity (ERROR, WARNING, INFO), object (e.g. SD_ORDER, FI_POSTING, BC_BATCH), transactionCode (e.g. VA01, FB01, SM37), or user.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['ERROR', 'WARNING', 'INFO'], description: 'Filter by log severity' },
          object: { type: 'string', description: 'Filter by SAP log object area (e.g. SD_ORDER, FI_POSTING)' },
          transactionCode: { type: 'string', description: 'Filter by transaction code (e.g. VA01, FB01, SM37)' },
          user: { type: 'string', description: 'Filter by executing user' },
          top: { type: 'number', description: 'Maximum log entries to return (default 50)' }
        }
      }
    }
  },
  // --- SAP Operations Agent Tools (Interface Monitoring) ---
  // 15. Check Failed Interfaces
  {
    type: 'function',
    function: {
      name: 'check_failed_interfaces',
      description: 'Checks and lists all failed SAP integration interfaces (CPI, AIF, SFTP, REST, OData) requiring operational inspection.',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: 'Maximum failed interfaces to return (default 50)' }
        }
      }
    }
  },
  // 16. Propose Retrigger Interface
  {
    type: 'function',
    function: {
      name: 'propose_retrigger_interface',
      description: 'Proposes retriggering a failed integration interface flow. Only valid for recoverable errors (RETRY recommendation, Risk Level <= 2). Does NOT execute directly — creates a dry-run preview requiring human confirmation in the UI. Strictly rejected if diagnosis requires escalation.',
      parameters: {
        type: 'object',
        properties: {
          interfaceId: { type: 'string', description: 'The exact interfaceId to retrigger (e.g. IF_101)' }
        },
        required: ['interfaceId']
      }
    }
  },
  // --- Level 3 Sensitive Action Proposal Tools ---
  // 17. Propose Master Data Change
  {
    type: 'function',
    function: {
      name: 'propose_change_master_data',
      description: 'Level 3 Sensitive: Proposes updating sensitive SAP master data fields (e.g. Business Partner, Material Master). Requires mandatory human confirmation, audit logging, and a mandatory business justification reason.',
      parameters: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            description: 'The master data entity key (e.g. businessPartner).'
          },
          recordId: {
            type: 'string',
            description: 'The exact record ID to modify.'
          },
          changes: {
            type: 'object',
            description: 'Key-value map of master data fields to update.'
          },
          reason: {
            type: 'string',
            description: 'Mandatory business justification reason for this change.'
          }
        },
        required: ['entityKey', 'recordId', 'changes']
      }
    }
  },
  // 18. Propose Release Purchase Order
  {
    type: 'function',
    function: {
      name: 'propose_release_purchase_order',
      description: 'Level 3 Sensitive: Proposes releasing an SAP Purchase Order (ME28 / ME29N). Requires mandatory human confirmation, audit logging, and a mandatory business justification reason.',
      parameters: {
        type: 'object',
        properties: {
          poNumber: {
            type: 'string',
            description: 'The exact Purchase Order number (e.g. 4500000001).'
          },
          reason: {
            type: 'string',
            description: 'Mandatory business justification reason for releasing the purchase order.'
          }
        },
        required: ['poNumber']
      }
    }
  },
  // 19. Propose Post Financial Document
  {
    type: 'function',
    function: {
      name: 'propose_post_financial_document',
      description: 'Level 3 Sensitive: Proposes posting a financial accounting document (FB01 / FB50). Highest operational scrutiny. Requires mandatory human confirmation, audit logging, and a mandatory business justification reason.',
      parameters: {
        type: 'object',
        properties: {
          companyCode: {
            type: 'string',
            description: 'SAP Company Code (e.g. 1000).'
          },
          documentType: {
            type: 'string',
            description: 'Document Type (e.g. SA).'
          },
          currency: {
            type: 'string',
            description: 'Document Currency (e.g. USD, EUR).'
          },
          headerText: {
            type: 'string',
            description: 'Document header text or reference.'
          },
          items: {
            type: 'array',
            description: 'Financial document line items.',
            items: {
              type: 'object',
              properties: {
                glAccount: { type: 'string' },
                amount: { type: 'number' },
                debitCredit: { type: 'string', enum: ['S', 'H', 'D', 'C'] },
                itemText: { type: 'string' }
              },
              required: ['glAccount', 'amount', 'debitCredit']
            }
          },
          reason: {
            type: 'string',
            description: 'Mandatory business justification reason for posting the document.'
          }
        },
        required: ['companyCode', 'items']
      }
    }
  },
  // Legacy aliases for backward compatibility with existing tests
  {
    type: 'function',
    function: {
      name: 'get_business_partners',
      description: 'Legacy alias for fetching Business Partners for read-only queries (filters may be empty or omitted).',
      parameters: {
        type: 'object',
        properties: {
          filters: { type: 'array' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_update_business_partner',
      description: 'Legacy alias for proposing update to Business Partner.',
      parameters: {
        type: 'object',
        properties: {
          businessPartnerId: { type: 'string' },
          changes: { type: 'object' }
        },
        required: ['businessPartnerId', 'changes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_create_business_partner',
      description: 'Legacy alias for proposing create Business Partner.',
      parameters: {
        type: 'object',
        properties: {
          fields: { type: 'object' }
        },
        required: ['fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_delete_business_partner',
      description: 'Legacy alias for proposing delete Business Partner.',
      parameters: {
        type: 'object',
        properties: {
          businessPartnerId: { type: 'string' },
          changes: { type: 'object' }
        },
        required: ['businessPartnerId']
      }
    }
  },
  // Material Maintenance Check (MARC / Plant verification)
  {
    type: 'function',
    function: {
      name: 'check_material_maintenance',
      description: 'Checks whether materials are extended and maintained in a specific SAP plant in MARC/MARA. Call this whenever the user asks to check, verify, test, or display material maintenance or MARC table for any material(s) or BOM components in a plant (e.g. "check sg21 in plant 1000", "sg22 from 1000", "check material in plant", "display marc table for SG21 plant 1000"). Returns maintenance status (OK, NOT_EXTENDED, NOT_FOUND, DELETION_FLAG, BLOCKED, UNKNOWN) for each material.',
      parameters: {
        type: 'object',
        properties: {
          materials: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of material numbers/identifiers to check for plant maintenance (e.g. ["SG21", "SG22", "A1BH0214C"]).'
          },
          bomMaterial: {
            type: 'string',
            description: 'Optional parent/BOM material whose components should be expanded and checked.'
          },
          plant: {
            type: 'string',
            description: 'Target SAP plant code (e.g. 1000, 1001, 1012).'
          },
          bomUsage: {
            type: 'string',
            description: 'Optional BOM usage if expanding a BOM (default: 1).'
          }
        },
        required: ['plant']
      }
    }
  }
];

const dynamicEntitiesDescription = getSystemPromptEntitiesDescription();

const SYSTEM_PROMPT = `You are an SAP Assistant. You help users query, analyze, and manage SAP records across multiple data domains.

AVAILABLE SAP ENTITIES:
${dynamicEntitiesDescription}

===================================================================
INTENT CLASSIFICATION & TOOL CALLING RULES (CRITICAL):
===================================================================
1. WRITE INTENT (IMMEDIATE PROPOSAL — NO PRE-READ NEEDED):
   - Clear signal words for a WRITE intent: 'change', 'update', 'set', 'modify', 'correct', 'fix', 'create', 'add', 'delete', 'remove' + a specific field + a specific record identifier.
   - When the user's message contains an explicit instruction to change, update, modify, set, or correct a field on a SPECIFIC record (identifiable by ID or clearly resolvable to exactly one record, e.g., 'change id 1003 category from organization to person' or 'update BP 1000 city to Bangalore'):
     --> Call 'propose_update_entity_record' DIRECTLY.
     --> Do NOT first call 'get_entity_data' to 'look up' the record unless the record's identity is truly ambiguous (see below).
     --> Treat these as immediate propose_* calls, not read-then-ask-again.
   - For creating a new record: Call 'propose_create_entity_record' DIRECTLY.
   - For Bill of Materials (BOM) creation: Required fields are Material Number ('material'), Plant Code ('plant'), BOM Usage ('bomUsage'), and Components ('components' array). If any required field is missing from the user's request (e.g. components missing), you may call 'propose_create_entity_record' with the provided fields so the system prompts for the missing fields, or politely ask the user for the missing required fields before proceeding.
   - For Bill of Materials (BOM) Copy-From / Reference creation: When user asks to create a BOM by copying from another plant/material (e.g., "create a new BOM for A1BH0214C in plant 1001 by copying from plant 1012" or "copy BOM from plant 1012 to plant 1001"):
     --> Use 'propose_copy_bom' DIRECTLY.
      --> The system automatically validates that the source BOM exists in CS03 and ensures source != target before proposing.
     --> Extract parameters: sourceMaterial, sourcePlant, sourceUsage (default "1"), targetMaterial, targetPlant, targetUsage (default "1").
   - For Bill of Materials (BOM) Deletion: When user asks to delete or remove a BOM or alternative BOM (e.g., "delete BOM for A1BH0214C in plant 1001 alternative BOM 2" or "delete alternative BOM 2"):
     --> Use 'propose_delete_bom' DIRECTLY.
     --> Do NOT attempt to look up or validate the BOM via 'get_entity_data' first, since that data source isn't connected. The GUI automation itself will verify and handle deletion via ZBOM_COPY.
     --> Extract parameters: material, plant, alternativeBom, bomUsage (default "1").
     --> BOM deletion is a destructive operation; NEVER execute directly. Propose it for explicit human confirmation.
   - For deleting a specific record by ID: Call 'propose_delete_entity_record' DIRECTLY.

2. READ INTENT:
   - For Bill of Materials queries (e.g. "Bills of Materials", "BOM", "show BOMs", "list BOM"): Call 'get_entity_data' with entityKey: 'bom'.
   - Call 'get_entity_data' first ONLY if:
     a) The user hasn't specified enough to identify a single record (e.g., 'change the Chennai one's category' when multiple Chennai records exist, or 'update Acme'), OR
     b) The user is explicitly asking to see/view/find/search/list data with no mention of changing anything.
   - Translate user search/filter criteria into conditions matching the exact column names for that entity. Use 'eq' for exact matches, 'ge'/'le' for ranges, and 'contains' for partial text matches. Only use column names defined for the selected entity.
   - For Job Monitoring: 'failed', 'unsuccessful', 'errored' all mean status/previousRunStatus = 'CANCELLED'. 'succeeded', 'successful', 'completed' mean 'FINISHED'. 'in progress', 'active' mean 'RUNNING'. Always translate these synonyms to the exact stored value before building a filter.

3. CONVERSATION CONTEXT & SHORT CONFIRMATIONS:
   - Always refer to previous user and assistant turns in the conversation history to understand context.
   - If you previously offered to show/pull data (e.g., "Want me to pull a few records to browse?", "Would you like me to show the records?"), and the user responds with a short confirmation (e.g., 'show', 'yes', 'ok', 'sure', 'please', 'yep', 'go ahead'):
     --> Treat it as agreement to your own prior offer and proceed with the action you proposed.
     --> Call 'get_entity_data' immediately for that entity with no filters (using an empty filters array [] or omitting filters), returning default/paginated results.
     --> Do NOT reject the short response and do NOT ask again.

4. MATERIAL MAINTENANCE & MARC CHECK (check_material_maintenance):
   - Whenever the user asks to check, verify, test, or display material maintenance or table MARC for material(s) in a plant (e.g., "check sg21 in plant 1000", "sg22 from 1000", "material-sg21, plant -1000, BOM-1, now check this in marc table", "check maintenance for A1BH0214C in 1001", "display marc table"):
     --> Call 'check_material_maintenance' DIRECTLY.
     --> Extract the material identifier(s) (e.g. "SG21", "SG22", "MATERIAL-SG21", "A1BH0214C") into 'materials': ["SG21"] and the plant code (e.g. "1000") into 'plant': "1000".
     --> If the user mentions a BOM material to expand (e.g. "expand BOM A1BH0214C in 1001"), pass 'bomMaterial': "A1BH0214C" and 'plant': "1001".
     --> Treat any term (such as SG21, SG22, MAT-01, 11021735, RAW_EVA_01) as a material number to check. Do NOT refuse or lecture the user by assuming it is an SAP view name or menu item; immediately execute 'check_material_maintenance'.

5. EDGE CASE / AMBIGUITY FALLBACK FOR READS:
   - If you genuinely must perform a read first (e.g. because the record's identity was ambiguous or missing and the user requested a change):
     --> Your accompanying reply text must NOT just silently show data.
     --> You MUST ask an explicit question connecting the found record to the user's intended change, e.g.:
         "I found this record (ID: 1003) — would you like me to change its Category to Person?"
         or "Multiple records matched: [IDs]. Which record would you like to update?"
     --> Never simply display the table with no indication that a change was requested.

WRITE OPERATIONS & SAFETY RULES:
1. YOU CAN NEVER DIRECTLY EXECUTE WRITES: You can only propose changes using:
   - 'propose_update_entity_record'
   - 'propose_create_entity_record'
   - 'propose_copy_bom'
   - 'propose_delete_bom'
   - 'propose_delete_entity_record'
   - 'propose_retry_job'
   - 'propose_reprocess_idoc'
   - 'propose_retrigger_interface'
   - 'propose_change_master_data'
   - 'propose_release_purchase_order'
   - 'propose_post_financial_document'
   Do NOT call 'execute_confirmed_action'. Writes execute ONLY when the human user clicks the Confirm button in the application UI.
2. DRY-RUN PROPOSALS:
   - When proposing an update, specify only editable fields in 'changes'.
     * For Business Partner Category: use '1' for Person and '2' for Organization.
   - When proposing a create, include all required fields for that entity.
   - After a propose tool succeeds, inform the user in 1-2 sentences that a proposal has been prepared and they must review and confirm it in the UI card.

===================================================================
MULTI-SYSTEM ROUTING & PRODUCTION ENVIRONMENT SAFETY:
===================================================================
1. The assistant operates across multiple SAP environments: DEV (Development/Sandbox), QA (Quality Assurance), and PROD (Production).
2. Read operations are permitted across all environments.
3. In PROD, Level 3 sensitive actions are subjected to double-confirmation: the user is required to explicitly enter "CONFIRM" before the backend will execute the change.
4. Always clarify which environment (e.g. DEV vs PROD) a proposed change targets.

===================================================================
LEVEL 3 SENSITIVE ACTIONS & MANDATORY JUSTIFICATION:
===================================================================
1. Level 3 tools:
   - 'propose_change_master_data': Modifies sensitive master data (Business Partner, Material Master).
   - 'propose_release_purchase_order': Releases a Purchase Order (ME28 / ME29N).
   - 'propose_post_financial_document': Posts a financial accounting document (FB01 / FB50).
2. All Level 3 actions:
   - NEVER execute directly. Only propose dry-run previews.
   - MANDATORY business justification: Every Level 3 action mandates that the user provides a business reason before execution can proceed.
   - When the user asks to release a PO or post FI document or change master data, call the appropriate propose tool.

===================================================================
ERROR KNOWLEDGE BASE & OCCURRENCE METRICS:
===================================================================
1. The system maintains a persistent catalogue of known operational failure patterns with empirical metrics:
   - occurrenceCount: Number of times an error pattern has been diagnosed.
   - successfulResolutionCount: Number of times remediation succeeded.
2. In diagnosis responses, highlight the confidence and recurrence of the error pattern if helpful.

===================================================================
SAP AI OPERATIONS AGENT - BACKGROUND JOB MONITORING (SM37):
===================================================================
1. OPERATIONS TOOLS:
   - 'check_failed_jobs': Use whenever the user asks to check, inspect, or list failed or cancelled background jobs.
   - 'read_job_log': Use to inspect execution and error logs for a specific jobId.
   - 'diagnose_job_failure': Analyzes the error log, classifies against the runbook into category, recommendedAction (RETRY vs ESCALATE), and risk level.
   - 'propose_retry_job': Proposes retrying a failed background job. Only valid for recoverable errors (RETRY, Risk Level <= 2).

2. MANDATORY RUNBOOK RULES:
   - ALWAYS DIAGNOSE FIRST: Before proposing a retry for any failed job, you MUST run 'diagnose_job_failure' first to verify if the failure is recoverable.
   - RECOVERABLE ERRORS (Risk Level <= 2, RETRY recommended): Transient database connection timeout, RFC communication failure, Remote system unavailable. Explain and call 'propose_retry_job'.
   - NON-RECOVERABLE ERRORS (Risk Level 3+, ESCALATE recommended): Missing authorizations (SAP Security/PFCG), Duplicate records / data inconsistency (Functional Consultant). NEVER call 'propose_retry_job' when diagnosis is ESCALATE. Explain root cause and escalate.

===================================================================
SAP AI OPERATIONS AGENT - IDOC MONITORING (WE02/WE05):
===================================================================
1. OPERATIONS TOOLS:
   - 'check_failed_idocs': Use whenever the user asks to check, inspect, or list failed IDocs (status 51-Error).
   - 'read_idoc_detail': Inspects detailed data and error segments for an IDoc by idocNumber.
   - 'diagnose_idoc_failure': Analyzes IDoc error segments against runbook catalogue into category, recommendedAction (RETRY vs ESCALATE), and risk level.
   - 'propose_reprocess_idoc': Proposes reprocessing a failed IDoc. Only valid for recoverable errors (RETRY, Risk Level <= 2).

2. MANDATORY RUNBOOK RULES:
   - ALWAYS DIAGNOSE FIRST: Before proposing reprocessing, verify if failure is recoverable.
   - RECOVERABLE ERRORS (Risk Level <= 2, RETRY recommended): Temporary connection loss to gateway, partner system busy / lock wait timeout, transient RFC failure. Propose reprocessing with 'propose_reprocess_idoc'.
   - NON-RECOVERABLE ERRORS (Risk Level 3+, ESCALATE recommended): Partner profile missing in WE20, Segment mapping error / missing mandatory segment fields. NEVER call 'propose_reprocess_idoc' for these errors! Explain the error and escalate to EDI/Functional team.
   - STATUS SYNONYMS: 'failed', 'error', 'errored' mean status = '51-Error'. 'succeeded', 'successful', 'processed' mean '53-Successful'. 'waiting' means '64-Waiting'. 'sent' means '03-Sent'.

===================================================================
SAP AI OPERATIONS AGENT - APPLICATION LOGS (SLG1):
===================================================================
1. OPERATIONS TOOLS:
   - 'check_application_logs': Inspects SLG1 application logs. Filterable by severity ('ERROR', 'WARNING', 'INFO'), object (e.g. 'SD_ORDER', 'FI_POSTING', 'MM_INVOICE', 'BC_BATCH'), transactionCode (e.g. 'VA01', 'FB01', 'MIRO', 'SM37', 'WE02'), and user.
   - SEVERITY SYNONYMS: 'error', 'err', 'failed' mean severity = 'ERROR'. 'warning', 'warn' mean severity = 'WARNING'. 'info' means severity = 'INFO'.

===================================================================
SAP AI OPERATIONS AGENT - INTERFACE MONITORING (CPI/AIF/SFTP):
===================================================================
1. OPERATIONS TOOLS:
   - 'check_failed_interfaces': Use whenever the user asks to check, inspect, or list failed integration interfaces or flows.
   - 'propose_retrigger_interface': Proposes retriggering a failed interface flow. Only valid for recoverable errors (RETRY, Risk Level <= 2).

2. MANDATORY RUNBOOK RULES:
   - RECOVERABLE ERRORS (Risk Level <= 2, RETRY recommended): Gateway timeout HTTP 504, SFTP transient connection drops, Kafka broker timeout. Propose retrigger with 'propose_retrigger_interface'.
   - NON-RECOVERABLE ERRORS (Risk Level 3+, ESCALATE recommended): SSL/TLS certificate expired, payload schema validation failed (missing tax jurisdiction, bad XML). NEVER call 'propose_retrigger_interface'! Explain root cause and escalate to Basis / Integration / Dev team.
   - STATUS SYNONYMS: 'failed', 'error', 'errored' mean status = 'FAILED'. 'succeeded', 'successful', 'healthy', 'completed' mean 'SUCCESS'. 'pending', 'running' mean 'PENDING'.

===================================================================
SAP AI OPERATIONS AGENT - MATERIAL MAINTENANCE & MARC CHECK:
===================================================================
1. OPERATIONS TOOLS:
   - 'check_material_maintenance': Checks whether materials are extended and maintained in a specific plant by reading table MARC (and MARA when unextended).
2. USAGE RULES:
   - When the user asks to check, inspect, verify, or display MARC table or material maintenance in a plant (e.g. "sg22 from 1000", "check sg21 in plant 1000", "material-sg21, plant -1000, BOM-1, now check this in marc table", "check material in plant"):
     --> Call 'check_material_maintenance' immediately.
     --> Extract materials: e.g. ["SG21"] or ["SG22"] and plant: e.g. "1000".
     --> Do NOT lecture or refuse the user by guessing about SAP purchasing/sales view codes (e.g., SG21, SG22). Always treat any material reference as a material ID to check.

OUTPUT INSTRUCTIONS:
- Give a SHORT natural-language reply only (1-2 sentences max).
- Do NOT format data as a markdown table in your text response.
- Do NOT list out individual records in prose or bullet points.
- Just summarize: count of results, proposal status, or clarifying question.
- The actual detailed data or proposal preview renders in the dedicated UI components — do not duplicate raw tables in the chat text.`;

/**
 * Helper to retrieve decrypted credentials from active session if available
 */
function getSessionCredentials(req) {
  const sessionId = req.cookies?.sap_session_id;
  if (!sessionId) return null;

  const session = sessionStore.getSession(sessionId);
  if (!session) return null;

  try {
    return decryptCredentials(session.encryptedCredentials);
  } catch {
    return null;
  }
}

/**
 * Helper to retrieve username from active session
 */
function getSessionUsername(req) {
  if (process.env.SKIP_GATEWAY_AUTH === 'true') {
    return process.env.GATEWAY_BYPASS_USER || getActiveSapUser() || 'LEELAM_EXT';
  }

  const sessionId = req.cookies?.sap_session_id;
  if (!sessionId) return getActiveSapUser() || 'MOCK_USER';

  const session = sessionStore.getSession(sessionId);
  return session?.username || getActiveSapUser() || 'MOCK_USER';
}

/**
 * Safe helper to fetch a single entity record without throwing unhandled rejections.
 */
async function safeGetEntityRecord(entityKey, id, credentials = null, systemKey = null) {
  try {
    return await getEntityRecordById(entityKey, id, credentials, systemKey);
  } catch (err) {
    console.warn(`[chat.js] safeGetEntityRecord failed for ${entityKey} #${id}:`, err.message);
    return null;
  }
}

/**
 * Validates parsed tool arguments before executing backend functions for an entity.
 */
export function validateToolArgs(entityKey, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, filters: [] };
  }

  // 1. Generic filters array case (if explicitly provided)
  if ('filters' in args && args.filters !== undefined && args.filters !== null) {
    if (!Array.isArray(args.filters)) {
      console.warn('[validateToolArgs] "filters" property is not an array:', args.filters);
      return { valid: false, filters: [] };
    }

    // Empty filters array is valid (means "no filters, return default/paginated records")
    if (args.filters.length === 0) {
      return { valid: true, filters: [] };
    }

    const validFilters = [];
    for (const f of args.filters) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        console.warn('[validateToolArgs] Dropping non-object filter item:', f);
        continue;
      }

      const { column, operator, value } = f;

      if (typeof column !== 'string' || !isValidColumn(entityKey, column)) {
        console.warn(`[validateToolArgs] Dropping unrecognized column in filter: "${column}"`);
        continue;
      }

      if (typeof operator !== 'string' || !isValidOperator(operator)) {
        console.warn(`[validateToolArgs] Dropping unsupported operator in filter: "${operator}"`);
        continue;
      }

      if (typeof value !== 'string') {
        console.warn('[validateToolArgs] Dropping non-string value in filter:', value);
        continue;
      }

      let normalizedValue = value.trim();
      const valLower = normalizedValue.toLowerCase();
      if (valLower === '' || valLower === 'null' || valLower === 'undefined' || valLower === '[object object]') {
        console.warn('[validateToolArgs] Dropping invalid/empty value in filter:', value);
        continue;
      }

      const colTrimmed = column.trim();
      if (entityKey === 'backgroundJob' && (colTrimmed === 'status' || colTrimmed === 'previousRunStatus')) {
        if (['failed', 'unsuccessful', 'errored', 'fail', 'error', 'cancelled', 'canceled'].includes(valLower)) {
          normalizedValue = 'CANCELLED';
        } else if (['succeeded', 'successful', 'completed', 'success', 'done', 'finished'].includes(valLower)) {
          normalizedValue = 'FINISHED';
        } else if (['in progress', 'in-progress', 'active', 'running'].includes(valLower)) {
          normalizedValue = 'RUNNING';
        } else if (['scheduled', 'queued', 'pending'].includes(valLower)) {
          normalizedValue = 'SCHEDULED';
        }
      } else if (entityKey === 'idoc' && colTrimmed === 'status') {
        if (['failed', 'error', 'errored', '51', '51-error'].includes(valLower)) {
          normalizedValue = '51-Error';
        } else if (['success', 'succeeded', 'processed', 'successful', '53', '53-successful'].includes(valLower)) {
          normalizedValue = '53-Successful';
        } else if (['waiting', 'ready', 'queued', '64', '64-waiting'].includes(valLower)) {
          normalizedValue = '64-Waiting';
        } else if (['sent', 'dispatched', '03', '03-sent'].includes(valLower)) {
          normalizedValue = '03-Sent';
        }
      } else if (entityKey === 'interfaceMonitor' && colTrimmed === 'status') {
        if (['failed', 'error', 'errored', 'fail', 'failing'].includes(valLower)) {
          normalizedValue = 'FAILED';
        } else if (['success', 'succeeded', 'healthy', 'successful', 'done', 'ok'].includes(valLower)) {
          normalizedValue = 'SUCCESS';
        } else if (['pending', 'running', 'in progress', 'queued'].includes(valLower)) {
          normalizedValue = 'PENDING';
        }
      } else if (entityKey === 'applicationLog' && colTrimmed === 'severity') {
        if (['err', 'error', 'errors', 'failed'].includes(valLower)) {
          normalizedValue = 'ERROR';
        } else if (['warn', 'warning', 'warnings'].includes(valLower)) {
          normalizedValue = 'WARNING';
        } else if (['info', 'information'].includes(valLower)) {
          normalizedValue = 'INFO';
        }
      }

      validFilters.push({
        column: colTrimmed,
        operator: operator.trim().toLowerCase(),
        value: normalizedValue
      });
    }

    if (validFilters.length === 0) {
      console.warn('[validateToolArgs] All provided filters were invalid.');
      return { valid: false, filters: [] };
    }

    return { valid: true, filters: validFilters };
  }

  // 2. Legacy parameters fallback ({ city, fromId, toId, category })
  const checkedFields = ['city', 'fromId', 'toId', 'category'];
  const legacyArgs = {};
  let hasAnyField = false;

  for (const field of checkedFields) {
    if (field in args && args[field] !== undefined && args[field] !== null) {
      const val = args[field];

      if (typeof val !== 'string') {
        return { valid: false, filters: [] };
      }

      const normalized = val.trim().toLowerCase();
      if (normalized === 'null' || normalized === 'undefined' || normalized === '[object object]') {
        return { valid: false, filters: [] };
      }

      hasAnyField = true;
      legacyArgs[field] = val.trim();
    }
  }

  if (hasAnyField) {
    return { valid: true, filters: [], legacyArgs };
  }

  // 3. No filters specified or omitted (e.g. { entityKey: 'businessPartner' }, { top: 10 }, {})
  // This is a completely valid no-filter query: return default/paginated results.
  return { valid: true, filters: [] };
}

/**
 * Detects if the model generated literal pseudo-tool-call text syntax in message.content
 * instead of invoking OpenRouter's structured tool_calls API.
 * e.g., "<tool_call><function=propose_update_entity_record>..."
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isPseudoToolCallContent(content) {
  if (!content || typeof content !== 'string') return false;
  const suspiciousPatterns = [
    /<tool_call/i,
    /<\/tool_call>/i,
    /<function=/i,
    /<\/function>/i,
    /<tool_calls/i,
    /<\/tool_calls>/i,
    /<function_calls/i,
    /<\/function_calls>/i,
    /\[tool_call/i,
    /\[\/tool_call/i,
    /<tool>/i,
    /<\/tool>/i
  ];

  return suspiciousPatterns.some((pattern) => pattern.test(content));
}

/**
 * Logs the real HTTP status code and full error body/message returned by OpenRouter
 */
function logOpenRouterError(stage, err) {
  const status = err.response?.status ?? 'No HTTP Status (Network/Connection Error)';
  const statusText = err.response?.statusText || '';
  const errorData = err.response?.data || err.message;

  console.error('\n=================== OPENROUTER API ERROR ===================');
  console.error(`Stage: ${stage}`);
  console.error(`Real HTTP Status Code: ${status} ${statusText}`.trim());
  console.error('Real Error Message/Body:');
  try {
    console.error(typeof errorData === 'object' ? JSON.stringify(errorData, null, 2) : errorData);
  } catch {
    console.error(errorData);
  }
  console.error('============================================================\n');
}

/**
 * POST /api/chat
 * Multi-entity conversational endpoint supporting read & human-confirmed writes.
 */
router.post('/', async (req, res) => {
  const username = getSessionUsername(req);
  const systemKey = req.body?.systemKey && isValidSystemKey(req.body.systemKey)
    ? req.body.systemKey
    : DEFAULT_SYSTEM;

  // -------------------------------------------------------------
  // 1. Direct Execution via Human Confirmation in UI
  // -------------------------------------------------------------
  if (req.body?.confirmAction) {
    const { confirmAction: actionId } = req.body;
    const action = pendingActionStore.getPendingAction(actionId);

    if (!action) {
      return res.status(200).json({
        reply: '⚠️ This action proposal has expired or was not found. Please request the change again.',
        data: null,
        error: true,
        expired: true
      });
    }

    const actionSystem = action.systemKey || systemKey;
    const isLevel3OrAbove = (action.riskLevel && action.riskLevel >= 3) ||
      requiresChangeReason(action.riskLevel) ||
      Boolean(action.requiresReason) ||
      ['release_po', 'post_fi_doc', 'change_master_data'].includes(action.type);
    const providedReason = (req.body?.reason !== undefined ? req.body.reason : (action.reason || '')).trim();

    // Level 3 Mandatory Reason Check
    if (isLevel3OrAbove && !providedReason) {
      return res.status(400).json({
        reply: '⚠️ Business reason for change is mandatory for Level 3 sensitive actions.',
        error: true,
        requiresReason: true
      });
    }

    // PROD Safeguard: double confirmation keyword 'CONFIRM'
    if (actionSystem === 'PROD' && isLevel3OrAbove) {
      const prodConfirm = req.body?.prodConfirmation?.trim();
      if (prodConfirm !== 'CONFIRM') {
        return res.status(400).json({
          reply: '⚠️ Production safeguard: You must type "CONFIRM" to authorize Level 3 sensitive actions in PROD.',
          error: true,
          requiresProdConfirm: true
        });
      }
    }

    const entityKey = action.entityKey || 'businessPartner';
    const schema = getEntitySchema(entityKey);
    const entityLabel = schema ? schema.singularLabel : 'Record';
    const recordId = action.recordId || action.businessPartnerId;
    try {
      // Session Safety Verification for SAP GUI Operations (only needed when using GUI)
      const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';
      if (!useRfc && ['copy_bom', 'delete_bom'].includes(action.type)) {
        const currentSelectedUser = getSelectedSapUser();
        const preflight = await ensureSapSession();
        if (!preflight.ok) {
          if (preflight.status === 'SERVER_UNAVAILABLE') {
            return res.status(200).json({
              reply: '⚠️ The SAP server is currently unavailable. Please start/reconnect SAP and try again.',
              error: true,
              sessionError: true,
              code: 'SAP_SERVER_UNAVAILABLE'
            });
          }
          return res.status(200).json({
            reply: '⚠️ The SAP session used to prepare this action is no longer available. Please select an active session and try again.',
            error: true,
            sessionError: true,
            code: preflight.code || 'SESSION_NOT_FOUND'
          });
        }
        if (action.expectedSapUser && currentSelectedUser && action.expectedSapUser.toUpperCase() !== currentSelectedUser.toUpperCase()) {
          return res.status(200).json({
            reply: `⚠️ Active SAP session changed from ${action.expectedSapUser} to ${currentSelectedUser}. Please re-confirm this operation under the new session.`,
            error: true,
            sessionChanged: true,
            code: 'SESSION_USER_CHANGED'
          });
        }
      }

      const credentials = getSessionCredentials(req);
      let result;
      let executedMessage = '';
      let data = null;

      if (action.type === 'update') {
        result = await updateEntityRecord(entityKey, recordId, action.payload, credentials, actionSystem);
        const nameVal = result.after?.[schema?.nameField] || '';
        executedMessage = `Successfully updated ${entityLabel} ${recordId}${nameVal ? ` (${nameVal})` : ''} in ${actionSystem}.`;
        data = [result.after];
      } else if (action.type === 'create') {
        result = await createEntityRecord(entityKey, action.payload, credentials, actionSystem);
        const newId = result.after?.[schema?.idField] || 'new';
        const nameVal = result.after?.[schema?.nameField] || '';
        executedMessage = `Successfully created ${entityLabel} ${newId}${nameVal ? ` (${nameVal})` : ''} in ${actionSystem}.`;
        data = [result.after];
      } else if (action.type === 'delete') {
        result = await deleteEntityRecord(entityKey, recordId, credentials, actionSystem);
        const nameVal = result.before?.[schema?.nameField] || '';
        executedMessage = `Successfully deleted ${entityLabel} ${recordId}${nameVal ? ` (${nameVal})` : ''} in ${actionSystem}.`;
        data = [];
      } else if (action.type === 'retry') {
        result = await retryBackgroundJob(recordId, actionSystem);
        const jobName = result.after?.jobName || '';
        executedMessage = `Successfully retried Background Job ${recordId}${jobName ? ` (${jobName})` : ''} in ${actionSystem}. Status updated to FINISHED.`;
        data = [result.after];
        if (action.category || action.errorCategory) {
          recordErrorOccurrence(action.category || action.errorCategory, true);
        }
      } else if (action.type === 'reprocess') {
        result = await reprocessIdoc(recordId, actionSystem);
        const idocType = result.after?.idocType || '';
        executedMessage = `Successfully reprocessed IDoc ${recordId}${idocType ? ` (${idocType})` : ''} in ${actionSystem}. Status updated to 53-Successful.`;
        data = [result.after];
        if (action.category || action.errorCategory) {
          recordErrorOccurrence(action.category || action.errorCategory, true);
        }
      } else if (action.type === 'retrigger') {
        result = await retriggerInterface(recordId, actionSystem);
        const ifaceName = result.after?.interfaceName || '';
        executedMessage = `Successfully retriggered Interface ${recordId}${ifaceName ? ` (${ifaceName})` : ''} in ${actionSystem}. Status updated to SUCCESS.`;
        data = [result.after];
        if (action.category || action.errorCategory) {
          recordErrorOccurrence(action.category || action.errorCategory, true);
        }
      } else if (action.type === 'release_po') {
        result = await releasePurchaseOrder(recordId, credentials, actionSystem);
        executedMessage = `Successfully released Purchase Order ${recordId} in ${actionSystem}. Status updated to 02 (Released).`;
        data = [result.after];
      } else if (action.type === 'post_fi_doc') {
        result = await postFinancialDocument(action.payload, credentials, actionSystem);
        const docNum = result.after?.documentNumber || 'NEW_DOC';
        executedMessage = `Successfully posted Financial Document ${docNum} (${result.after?.companyCode || ''}) in ${actionSystem}.`;
        data = [result.after];
      } else if (action.type === 'change_master_data') {
        result = await changeMasterData(entityKey, recordId, action.payload, credentials, actionSystem);
        executedMessage = `Successfully changed master data for ${entityLabel} ${recordId} in ${actionSystem}.`;
        data = [result.after];
      } else if (action.type === 'copy_bom') {
        const copyParams = action.payload;

        if (useRfc) {
          result = await rfcCopyBom({
            sourceMaterial: copyParams.source?.material || copyParams.sourceMaterial,
            sourcePlant: copyParams.source?.plant || copyParams.sourcePlant,
            targetMaterial: copyParams.target?.material || copyParams.targetMaterial,
            targetPlant: copyParams.target?.plant || copyParams.targetPlant,
            bomUsage: copyParams.target?.bomUsage || copyParams.bomUsage || '1',
            sourceAlternative: copyParams.source?.alternativeBom || copyParams.sourceAltBom || '1',
            targetAlternative: copyParams.target?.alternativeBom || copyParams.targetAltBom || '1'
          });

          if (!result.success) {
            const err = new Error(result.message || 'Copy BOM failed via RFC.');
            err.code = result.code || 'RFC_COPY_FAILED';
            throw err;
          }

          executedMessage = result.message || `Successfully copied BOM to ${copyParams.target?.material} in plant ${copyParams.target?.plant} via RFC.`;
          data = result.hierarchy && result.hierarchy.length > 0 ? result.hierarchy : [result.after || {
            material: copyParams.target?.material,
            plant: copyParams.target?.plant,
            alternativeBom: copyParams.target?.alternativeBom,
            bomUsage: copyParams.target?.bomUsage || '1',
            bomNumber: result.bomNumber,
            status: 'COPIED_VIA_RFC'
          }];
        } else {
          const preflight = await ensureSapSession();
          if (!preflight.ok) {
            const err = new Error(`Cannot execute Copy BOM: ${preflight.message}`);
            err.code = preflight.status === 'SERVER_UNAVAILABLE' ? 'SAP_SERVER_UNAVAILABLE' : (preflight.code || 'SAP_SESSION_NOT_FOUND');
            throw err;
          }

          const repairResult = await copyBomHierarchyWithRepair({
            source: copyParams.source,
            target: copyParams.target,
            validFrom: copyParams.target?.validFrom || copyParams.validFrom || '',
            maxDepth: 5,
            auditHook: (item, alternative, res) => {
              auditLogger.logAction({
                sapUsername: username,
                entityKey: 'bom',
                actionType: 'copy_bom',
                recordId: item.material,
                businessPartnerId: item.material,
                beforeValues: res?.before || null,
                afterValues: res?.after || null,
                sourcePrompt: item.isMain
                  ? (action.sourcePrompt || `Copy BOM hierarchy ${item.material}`)
                  : `Hierarchy sub-BOM copy (depth ${item.depth}) for main BOM ${copyParams.target?.material}`,
                actionId: `${action.actionId}_bom_${item.depth}_${item.material}_alt${alternative}`,
                system: actionSystem,
                task: item.isMain ? `Main BOM Copy (${item.material})` : `Sub-BOM Copy (${item.material})`,
                reason: providedReason || null
              });
            }
          });

          const mainRecord = repairResult.mainBom?.after || repairResult.createdBoms[0]?.after || {};
          result = {
            success: true,
            verified: true,
            status: 'SUCCESS',
            code: 'BOM_HIERARCHY_COPIED_AND_VERIFIED',
            message: repairResult.message,
            after: mainRecord,
            createdRecords: repairResult.createdBoms.map(b => b.after || b),
            totalBomsCreated: repairResult.totalBomsCreated,
            createdBoms: repairResult.createdBoms,
            hierarchyDepth: repairResult.hierarchyDepth,
            levelsVerified: repairResult.levelsVerified,
            verification: repairResult.verification
          };

          executedMessage = result.message;
          data = result.createdRecords;
        }
      } else if (action.type === 'delete_bom') {
        const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';
        const deleteParams = action.payload;
        if (useRfc) {
          result = await rfcDeleteBom(deleteParams);
          if (!result.success) {
            const err = new Error(result.message || 'Delete BOM failed via RFC.');
            err.code = result.code || 'RFC_DELETE_FAILED';
            throw err;
          }
          executedMessage = result.message || `Successfully deleted BOM for ${deleteParams.material} in plant ${deleteParams.plant} via RFC.`;
          data = [result.after || {
            material: deleteParams.material,
            plant: deleteParams.plant,
            alternativeBom: deleteParams.alternativeBom,
            bomUsage: deleteParams.bomUsage,
            status: 'DELETED_VIA_RFC'
          }];
        } else {
          const preflight = await ensureSapSession();
          if (!preflight.ok) {
            const err = new Error(`Cannot execute Delete BOM: ${preflight.message}`);
            err.code = preflight.status === 'SERVER_UNAVAILABLE' ? 'SAP_SERVER_UNAVAILABLE' : (preflight.code || 'SAP_SESSION_NOT_FOUND');
            throw err;
          }
          result = await deleteBomViaGui(deleteParams);
          if (!result.success || result.verified === false) {
            const err = new Error(result.message || 'Delete BOM failed or could not be verified in SAP GUI.');
            err.code = result.code || 'GUI_DELETE_FAILED';
            throw err;
          }
          executedMessage = result.message || `Successfully deleted BOM for ${deleteParams.material} in plant ${deleteParams.plant} (Alternative BOM ${deleteParams.alternativeBom || '1'}) via SAP GUI.`;
          data = [result.after || {
            material: deleteParams.material,
            plant: deleteParams.plant,
            alternativeBom: deleteParams.alternativeBom,
            bomUsage: deleteParams.bomUsage,
            status: 'DELETED_AND_VERIFIED_VIA_GUI'
          }];
        }
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }

      // Mandatory Audit Logging (for copy_bom, each BOM in the hierarchy is already logged individually above)
      if (action.type !== 'copy_bom') {
        auditLogger.logAction({
          sapUsername: username,
          entityKey,
          actionType: action.type,
          recordId: recordId || result.after?.[schema?.idField],
          businessPartnerId: recordId || result.after?.[schema?.idField],
          beforeValues: result.before,
          afterValues: result.after,
          sourcePrompt: action.sourcePrompt,
          actionId: action.actionId,
          system: actionSystem,
          reason: providedReason || null
        });
      }

      // Clear the action from pending store
      pendingActionStore.clearPendingAction(actionId);

      return res.status(200).json({
        reply: `✅ ${executedMessage}`,
        data,
        error: false,
        actionExecuted: {
          actionId,
          type: action.type,
          entityKey,
          system: actionSystem,
          recordId: recordId || result.after?.[schema?.idField],
          businessPartnerId: recordId || result.after?.[schema?.idField],
          reason: providedReason || null,
          status: result?.status,
          warnings: result?.warnings,
          differences: result?.differences
        },
        actionResult: {
          ...result,
          createdSubBoms: action.type === 'copy_bom' && Array.isArray(data) && data.length > 1 ? data.slice(0, -1) : []
        }
      });
    } catch (execErr) {
      console.error('Error executing confirmed action:', execErr);
      return res.status(200).json({
        reply: `❌ Execution failed: ${execErr.message}`,
        data: null,
        error: true
      });
    }
  }

  // -------------------------------------------------------------
  // 2. Direct Cancellation via UI
  // -------------------------------------------------------------
  if (req.body?.cancelAction) {
    const { cancelAction: actionId } = req.body;
    const action = pendingActionStore.getPendingAction(actionId);
    if (action) {
      pendingActionStore.clearPendingAction(actionId);
    }
    return res.status(200).json({
      reply: 'Action proposal was cancelled. No records were modified.',
      data: null,
      error: false,
      cancelled: true
    });
  }

  // -------------------------------------------------------------
  // 3. Conversational Message Handling
  // -------------------------------------------------------------
  const { message, history = [], actionType, copyBomParams, deleteBomParams } = req.body || {};
  const activeSystem = systemKey || req.sapSession?.systemKey || 'DEV';
  let activeEntitySchema = null;

  // Direct handling for structured Copy BOM form submission
  if (actionType === 'copy_bom' && copyBomParams) {
    const sourceMaterial = String(copyBomParams.sourceMaterial || '').trim();
    const sourcePlant = String(copyBomParams.sourcePlant || '').trim();
    const sourceUsage = String(copyBomParams.sourceUsage || '1').trim();
    const sourceAltBom = String(copyBomParams.sourceAltBom || '').trim();
    const targetMaterial = String(copyBomParams.targetMaterial || '').trim();
    const targetPlant = String(copyBomParams.targetPlant || '').trim();
    const targetUsage = String(copyBomParams.targetUsage || '1').trim();
    const targetAltBom = String(copyBomParams.targetAltBom || '').trim();
    const validFrom = String(copyBomParams.validFrom || '').trim();

    const validation = await validateCopyBomParameters({
      sourceMaterial,
      sourcePlant,
      sourceUsage,
      sourceAltBom,
      targetMaterial,
      targetPlant,
      targetUsage,
      targetAltBom
    });

    if (!validation.valid) {
      return res.status(200).json({
        reply: validation.message,
        data: null,
        proposedAction: null,
        entityKey: 'bom',
        schema: getEntitySchema('bom'),
        error: true
      });
    }

    const clean = validation.cleanParams;
    const hier = validation.hierarchy;
    const summary = hier?.metrics?.totalBomsToCreate > 1
      ? `Copy BOM Hierarchy (${hier.metrics.totalBomsToCreate} BOMs): ${clean.sourceMaterial} (${clean.sourcePlant}) → ${clean.targetMaterial} (${clean.targetPlant}, Alt ${clean.targetAltBom})`
      : `Copy BOM from Material ${clean.sourceMaterial} Plant ${clean.sourcePlant} Usage ${clean.sourceUsage} → to Material ${clean.targetMaterial} Plant ${clean.targetPlant} Usage ${clean.targetUsage}`;

    const preview = {
      entityKey: 'bom',
      entityLabel: 'Bill of Materials',
      summary,
      sourceMaterial: clean.sourceMaterial,
      sourcePlant: clean.sourcePlant,
      sourceUsage: clean.sourceUsage,
      sourceAltBom: clean.sourceAltBom,
      targetMaterial: clean.targetMaterial,
      targetPlant: clean.targetPlant,
      targetUsage: clean.targetUsage,
      targetAltBom: clean.targetAltBom,
      validFrom,
      hierarchy: hier,
      copyOrder: hier?.copyOrder || validation.copyOrder || [],
      hierarchyMetrics: hier?.metrics,
      formattedTree: hier?.tree ? formatHierarchyTree(hier.tree) : '',
      fields: {
        'Target Material': clean.targetMaterial,
        'Target Plant': clean.targetPlant,
        'Target Usage': clean.targetUsage,
        'Target Alternative BOM': clean.targetAltBom || 'Default',
        'Source Material': clean.sourceMaterial,
        'Source Plant': clean.sourcePlant,
        'Source Usage': clean.sourceUsage,
        'Source Alternative BOM': clean.sourceAltBom || 'Default',
        ...(validFrom ? { 'Valid From': validFrom } : {})
      },
      subBomDependencies: validation.subBomDependencies
    };

    const payload = {
      source: {
        material: clean.sourceMaterial,
        plant: clean.sourcePlant,
        bomUsage: clean.sourceUsage,
        alternativeBom: clean.sourceAltBom
      },
      target: {
        material: clean.targetMaterial,
        plant: clean.targetPlant,
        bomUsage: clean.targetUsage,
        alternativeBom: clean.targetAltBom,
        validFrom
      },
      sourceComponents: clean.sourceComponents || [],
      availableAlternatives: validation.availableAlternatives || [],
      hierarchy: hier,
      copyOrder: hier?.copyOrder || validation.copyOrder || [],
      subBomDependencies: validation.subBomDependencies
    };

    const pending = pendingActionStore.createPendingAction({
      type: 'copy_bom',
      entityKey: 'bom',
      recordId: clean.targetMaterial,
      payload,
      preview,
      sapUsername: req.user?.username || getActiveSapUser() || 'LEELAM_EXT',
      expectedSapUser: getSelectedSapUser() || getActiveSapUser() || null,
      selectedSessionId: getSelectedSapSessionId() || null,
      sourcePrompt: message ? message.trim() : summary
    });

    const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';
    return res.status(200).json({
      reply: `I have prepared a proposal to copy the Bill of Materials. Please review the details below and confirm to execute via ${useRfc ? 'SAP RFC / BAPI' : 'SAP GUI CS01'}:`,
      data: null,
      proposedAction: {
        actionId: pending.actionId,
        type: 'copy_bom',
        entityKey: 'bom',
        summary,
        preview,
        expiresAt: pending.expiresAt
      },
      entityKey: 'bom',
      schema: getEntitySchema('bom'),
      error: false
    });
  }

  // Direct handling for structured Delete BOM form submission
  if (actionType === 'delete_bom' && deleteBomParams) {
    const material = String(deleteBomParams.material || '').trim().toUpperCase();
    const plant = String(deleteBomParams.plant || '').trim().toUpperCase();
    const alternativeBom = String(deleteBomParams.alternativeBom || '1').trim();
    const bomUsage = String(deleteBomParams.bomUsage || '1').trim();

    if (!material || !plant) {
      return res.status(200).json({
        reply: 'Material and Plant are required to propose deleting a Bill of Materials.',
        data: null,
        proposedAction: null,
        entityKey: 'bom',
        schema: getEntitySchema('bom'),
        error: true
      });
    }

    const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';

    if (!useRfc) {
      const preflight = await ensureSapSession();
      if (!preflight.ok) {
        return res.status(200).json({
          reply: `Cannot propose deleting BOM: ${preflight.message}`,
          data: null,
          proposedAction: null,
          entityKey: 'bom',
          schema: getEntitySchema('bom'),
          error: true,
          code: preflight.status === 'SERVER_UNAVAILABLE' ? 'SAP_SERVER_UNAVAILABLE' : (preflight.code || 'SAP_SESSION_NOT_FOUND'),
          status: preflight.status
        });
      }
    }

    const bomCheck = useRfc
      ? await rfcReadBom({
          material,
          plant,
          bomUsage,
          alternativeBom
        })
      : await verifyBomInCs03({
          material,
          plant,
          bomUsage,
          alternativeBom
        });

    if (!bomCheck.success) {
      return res.status(200).json({
        reply: `Cannot verify BOM before deletion: ${bomCheck.message || 'SAP connection error.'} Workflow stopped.`,
        data: null,
        proposedAction: null,
        entityKey: 'bom',
        schema: getEntitySchema('bom'),
        error: true,
        code: bomCheck.code || 'SAP_SESSION_NOT_FOUND',
        status: bomCheck.status
      });
    }

    const bomExists = bomCheck.bomExists ?? bomCheck.exists;
    if (!bomExists) {
      const alts = bomCheck.availableAlternatives || [];
      const isAltNotFound = alts.length > 0 && !alts.includes(alternativeBom.padStart(2, '0')) && !alts.includes(alternativeBom);
      const failMsg = isAltNotFound
        ? `Alternative BOM ${alternativeBom} does not exist for material ${material} in plant ${plant}. Available alternatives: ${alts.join(', ')}.`
        : (bomCheck.message || `No BOM found for material ${material} in plant ${plant} with usage ${bomUsage}.`);

      return res.status(200).json({
        reply: `Cannot delete BOM: ${failMsg}`,
        data: null,
        proposedAction: null,
        entityKey: 'bom',
        schema: getEntitySchema('bom'),
        error: true,
        code: isAltNotFound ? 'ALTERNATIVE_NOT_FOUND' : 'BOM_NOT_FOUND'
      });
    }

    const summary = `Delete BOM: Material ${material} in Plant ${plant}, Alternative BOM ${alternativeBom}, Usage ${bomUsage}`;
    const preview = {
      entityKey: 'bom',
      entityLabel: 'Bill of Materials',
      summary,
      material,
      plant,
      alternativeBom,
      bomUsage,
      danger: true,
      requiresReason: false,
      riskLevel: 3,
      fields: {
        'Material': material,
        'Plant': plant,
        'Alternative BOM': alternativeBom,
        'BOM Usage': bomUsage
      }
    };

    const payload = {
      material,
      plant,
      alternativeBom,
      bomUsage
    };

    const pending = pendingActionStore.createPendingAction({
      type: 'delete_bom',
      entityKey: 'bom',
      recordId: material,
      payload,
      preview,
      sapUsername: req.user?.username || getActiveSapUser() || 'LEELAM_EXT',
      expectedSapUser: getSelectedSapUser() || getActiveSapUser() || null,
      selectedSessionId: getSelectedSapSessionId() || null,
      sourcePrompt: message ? message.trim() : summary
    });

    return res.status(200).json({
      reply: `⚠️ Please confirm the permanent deletion of this Bill of Materials. This operation will be executed directly via ${useRfc ? 'SAP RFC / BAPI' : 'SAP GUI ZBOM_COPY'}:`,
      data: null,
      proposedAction: {
        actionId: pending.actionId,
        type: 'delete_bom',
        entityKey: 'bom',
        summary,
        preview,
        riskLevel: 3,
        expiresAt: pending.expiresAt
      },
      entityKey: 'bom',
      schema: getEntitySchema('bom'),
      error: false
    });
  }
});

/**
 * Detects material check intent directly from user prompt text.
 * Handles inputs like:
 * - "sg22 from 1000"
 * - "check sg21 in plant 1000"
 * - "material-sg21, plant -1000, BOM-1, now check this in marc table"
 * - "check A1BH0214C in 1001"
 * - "display marc table for material SG21 in plant 1000"
 */
export function detectMaterialCheckIntent(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return null;
  const prompt = userPrompt.trim();

  // Extract plant: "plant 1000", "plant -1000", "plant: 1000", "in 1000", "from 1000"
  const plantMatch =
    prompt.match(/\bplant\s*[:=\-]?\s*([0-9]{3,4})\b/i) ||
    prompt.match(/\b(?:from|in|for)\s+plant\s*([0-9]{3,4})\b/i) ||
    prompt.match(/\b(?:from|in|for)\s+([0-9]{3,4})\b/i);

  if (!plantMatch) return null;
  const plant = plantMatch[1];

  // 1. Explicit material label: "material-sg21", "material: sg21", "material sg21", "materials: a, b"
  const matLabelMatch = prompt.match(/\bmaterials?\s*[:=\-]?\s*([A-Za-z0-9_\-\.\/,\s]+?)(?:,?\s*\b(?:plant|bom|in|from|usage|now)\b|$)/i);
  if (matLabelMatch) {
    const rawList = matLabelMatch[1]
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== 'BOM' && s !== 'PLANT' && s !== 'MARC' && s !== 'TABLE' && s !== 'NOW' && s !== 'CHECK');
    if (rawList.length > 0) {
      return { materials: rawList, plant };
    }
  }

  // 2. Action + Material: "check SG21 in plant 1000", "inspect SG22 from 1000", "display marc table for SG21"
  const checkActionMatch = prompt.match(/\b(?:check|inspect|verify|display|test|find)\s+(?:marc\s+(?:table\s+)?(?:for\s+)?)?([A-Za-z0-9_\-\.\/]+)\s+(?:in|from|for)\s+(?:plant\s*)?[0-9]{3,4}\b/i);
  if (checkActionMatch) {
    const m = checkActionMatch[1].trim().toUpperCase();
    if (m !== 'MARC' && m !== 'TABLE' && m !== 'MATERIAL' && m !== 'BOM') {
      return { materials: [m], plant };
    }
  }

  // 3. Short prompt: "SG22 from 1000" or "SG22 in 1000"
  const shortMatch = prompt.match(/^([A-Za-z0-9_\-\.\/]+)\s+(?:from|in|for)\s+(?:plant\s*)?[0-9]{3,4}\b/i);
  if (shortMatch) {
    const m = shortMatch[1].trim().toUpperCase();
    if (!['CHECK', 'SHOW', 'LIST', 'BOM', 'MARC', 'TABLE', 'CREATE', 'DELETE', 'UPDATE'].includes(m)) {
      return { materials: [m], plant };
    }
  }

  return null;
}

router.post('/', async (req, res) => {
  const { message, history } = req.body || {};
  let activeEntitySchema = null;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      reply: 'A user message is required.',
      data: null,
      error: true
    });
  }

  activeEntitySchema = getEntitySchema(resolveEntityKey(null, message));

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!apiKey || !apiKey.trim()) {
    return res.status(200).json({
      reply: '⚠️ OpenRouter API key is not configured. Please set OPENROUTER_API_KEY in backend/.env to enable conversational AI.',
      data: null,
      error: true,
      notConfigured: true
    });
  }

  if (!model || !model.trim()) {
    return res.status(200).json({
      reply: '⚠️ OPENROUTER_MODEL is not configured. Please set OPENROUTER_MODEL in backend/.env.',
      data: null,
      error: true,
      notConfigured: true
    });
  }

  const formattedHistory = Array.isArray(history)
    ? history
        .filter((msg) => msg && msg.role && msg.content && typeof msg.content === 'string')
        .map((msg) => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        }))
    : [];

  // If client history already includes the current user message at the end, remove it to prevent duplicate user turns
  if (
    formattedHistory.length > 0 &&
    formattedHistory[formattedHistory.length - 1].role === 'user' &&
    formattedHistory[formattedHistory.length - 1].content.trim() === message.trim()
  ) {
    formattedHistory.pop();
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...formattedHistory,
    { role: 'user', content: message.trim() }
  ];

  const headers = {
    'Authorization': `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
    'X-Title': 'SAP Multi-Entity Assistant'
  };

  try {
    let initialResponse;
    try {
      console.log(`[OpenRouter API Call #1] Model being sent in request body: "${model}"`);
      initialResponse = await axios.post(
        OPENROUTER_API_URL,
        {
          model,
          messages,
          tools: TOOLS,
          tool_choice: 'auto'
        },
        { headers, timeout: 30000 }
      );
    } catch (firstCallErr) {
      logOpenRouterError('Initial Call to OpenRouter', firstCallErr);

      if (firstCallErr.response?.status === 429) {
        const errorDetail =
          firstCallErr.response?.data?.error?.metadata?.raw ||
          firstCallErr.response?.data?.error?.message ||
          'OpenRouter free-tier rate limit reached.';

        return res.status(429).json({
          reply: `⚠️ OpenRouter rate limit: ${errorDetail}`,
          data: null,
          error: true,
          isRateLimit: true,
          realStatusCode: firstCallErr.response?.status,
          openRouterError: firstCallErr.response?.data || null
        });
      }

      const isTimeout = firstCallErr.code === 'ECONNABORTED' || firstCallErr.message?.includes('timeout');
      const errorReply = isTimeout
        ? 'The request to the AI service timed out. Please try again shortly.'
        : `Unable to connect to the AI service: ${firstCallErr.response?.data?.error?.message || firstCallErr.message}`;

      return res.status(200).json({
        reply: `⚠️ ${errorReply}`,
        data: null,
        error: true,
        realStatusCode: firstCallErr.response?.status || null,
        openRouterError: firstCallErr.response?.data || null
      });
    }

    const choice = initialResponse.data?.choices?.[0];
    const assistantMessage = choice?.message;

    if (!assistantMessage) {
      return res.status(200).json({
        reply: 'I was unable to process your request at this moment. Please try again.',
        data: null,
        entityKey: activeEntitySchema?.entityKey || null,
        schema: activeEntitySchema || null,
        error: true
      });
    }

    // Intercept literal pseudo-tool-call text in message.content when structured tool_calls is missing
    if (isPseudoToolCallContent(assistantMessage.content) && (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)) {
      console.warn('\n[chat.js] Detected pseudo-tool-call literal text in model message.content:');
      console.warn(assistantMessage.content);
      return res.status(200).json({
        reply: 'I had trouble understanding that request — could you rephrase it?',
        data: null,
        entityKey: activeEntitySchema?.entityKey || null,
        schema: activeEntitySchema || null,
        error: true
      });
    }

    // Intercept material check if model failed to call structured tools
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const matCheckIntent = detectMaterialCheckIntent(message);
      if (matCheckIntent) {
        assistantMessage.tool_calls = [
          {
            id: 'call_mat_' + Date.now(),
            type: 'function',
            function: {
              name: 'check_material_maintenance',
              arguments: JSON.stringify(matCheckIntent)
            }
          }
        ];
      }
    }

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const credentials = getSessionCredentials(req);
      const username = getSessionUsername(req);
      let combinedRecords = [];
      let pendingActionToReturn = null;
      let materialCheckResults = null;
      activeEntitySchema = activeEntitySchema || getEntitySchema(resolveEntityKey(null, message));
      const toolMessages = [...messages, assistantMessage];

      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function?.name;
        const rawArgsString = toolCall.function?.arguments || '{}';
        let toolArgs = {};

        try {
          toolArgs = JSON.parse(rawArgsString);
        } catch (parseErr) {
          console.error('Malformed JSON in tool_call arguments from model:', rawArgsString, 'Error:', parseErr.message);
          return res.status(200).json({
            reply: 'I had trouble understanding that request — could you rephrase it?',
            data: null,
            error: true
          });
        }

        // TOOL 1: get_entity_data (or legacy get_business_partners)
        if (fnName === 'get_entity_data' || fnName === 'get_business_partners') {
          const entityKey = resolveEntityKey(toolArgs.entityKey, message);
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;

          // Guardrail: If message is an explicit Copy-From BOM instruction, do NOT perform a lookup/read
          const copyFromRegex = /(?:copying|copy)\s+(?:a\s+BOM\s+)?(?:for\s+([A-Za-z0-9_-]+)\s+)?(?:in\s+plant\s+([A-Za-z0-9_-]+)\s+)?from\s+(?:plant\s+)?([A-Za-z0-9_-]+)/i;
          if (entityKey === 'bom' && copyFromRegex.test(message)) {
            const extracted = extractCopyBomParamsFromText(message);
            const match = message.match(copyFromRegex);
            const tgtMat = extracted.material || match?.[1] || toolArgs?.filters?.find((f) => f.column === 'material')?.value || 'A1BH0214C';
            const tgtPlant = extracted.targetPlant || match?.[2] || '1001';
            const srcPlant = extracted.sourcePlant || match?.[3] || toolArgs?.filters?.find((f) => f.column === 'plant')?.value || '1012';
            const srcMat = tgtMat;
            const srcUsage = '1';
            const tgtUsage = '1';

            const validation = await validateCopyBomParameters({
              sourceMaterial: srcMat,
              sourcePlant: srcPlant,
              sourceUsage: srcUsage,
              targetMaterial: tgtMat,
              targetPlant: tgtPlant,
              targetUsage: tgtUsage
            });

            if (!validation.valid) {
              return res.status(200).json({
                reply: validation.message,
                data: null,
                proposedAction: null,
                entityKey: 'bom',
                schema: schema || getEntitySchema('bom') || null,
                error: validation.code !== 'MISSING_FIELDS'
              });
            }

            const clean = validation.cleanParams;
            const hier = validation.hierarchy;
            const summary = hier?.metrics?.totalBomsToCreate > 1
              ? `Copy BOM Hierarchy (${hier.metrics.totalBomsToCreate} BOMs): ${clean.sourceMaterial} (${clean.sourcePlant}) → ${clean.targetMaterial} (${clean.targetPlant}, Alt ${clean.targetAltBom})`
              : `Copy BOM from Material ${clean.sourceMaterial} Plant ${clean.sourcePlant} Usage ${clean.sourceUsage} → to Material ${clean.targetMaterial} Plant ${clean.targetPlant} Usage ${clean.targetUsage}`;

            const preview = {
              entityKey: 'bom',
              entityLabel: 'Bill of Materials',
              summary,
              sourceMaterial: clean.sourceMaterial,
              sourcePlant: clean.sourcePlant,
              sourceUsage: clean.sourceUsage,
              sourceAltBom: clean.sourceAltBom,
              targetMaterial: clean.targetMaterial,
              targetPlant: clean.targetPlant,
              targetUsage: clean.targetUsage,
              targetAltBom: clean.targetAltBom,
              hierarchy: hier,
              copyOrder: hier?.copyOrder || validation.copyOrder || [],
              hierarchyMetrics: hier?.metrics,
              formattedTree: hier?.tree ? formatHierarchyTree(hier.tree) : '',
              fields: {
                'Target Material': clean.targetMaterial,
                'Target Plant': clean.targetPlant,
                'Target Usage': clean.targetUsage,
                'Target Alternative BOM': clean.targetAltBom || 'Default',
                'Source Material': clean.sourceMaterial,
                'Source Plant': clean.sourcePlant,
                'Source Usage': clean.sourceUsage,
                'Source Alternative BOM': clean.sourceAltBom || 'Default'
              },
              subBomDependencies: validation.subBomDependencies
            };
            const payload = {
              source: { material: clean.sourceMaterial, plant: clean.sourcePlant, bomUsage: clean.sourceUsage, alternativeBom: clean.sourceAltBom },
              target: { material: clean.targetMaterial, plant: clean.targetPlant, bomUsage: clean.targetUsage, alternativeBom: clean.targetAltBom },
              sourceComponents: clean.sourceComponents || [],
              availableAlternatives: validation.availableAlternatives || [],
              hierarchy: hier,
              copyOrder: hier?.copyOrder || validation.copyOrder || [],
              subBomDependencies: validation.subBomDependencies
            };
            const pending = pendingActionStore.createPendingAction({
              type: 'copy_bom',
              entityKey: 'bom',
              recordId: clean.targetMaterial,
              payload,
              preview,
              sapUsername: username,
              expectedSapUser: getSelectedSapUser() || username || null,
              selectedSessionId: getSelectedSapSessionId() || null,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'copy_bom',
              entityKey: 'bom',
              summary,
              preview,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                summary,
                preview
              })
            });
            continue;
          }

          // Guardrail: If message is an explicit Delete BOM instruction, do NOT perform a lookup/read
          const deleteBomRegex = /(?:delete|remove)\s+(?:a\s+)?(?:BOM|bill\s+of\s+materials)/i;
          if (entityKey === 'bom' && deleteBomRegex.test(message)) {
            const matMatch = message.match(/(?:for\s+)?([A-Za-z0-9_-]+)(?:\s+in\s+plant|\s+plant)/i);
            const plantMatch = message.match(/plant\s+([A-Za-z0-9_-]+)/i);
            const altMatch = message.match(/alt(?:ernative)?(?:\s*BOM)?\s*(\d+)/i);
            const delMat = matMatch?.[1] || toolArgs?.filters?.find((f) => f.column === 'material')?.value || 'A1BH0214C';
            const delPlant = plantMatch?.[1] || toolArgs?.filters?.find((f) => f.column === 'plant')?.value || '1001';
            const delAlt = altMatch?.[1] || '2';
            const delUsage = '1';

            const summary = `Delete BOM for Material ${delMat} in Plant ${delPlant} (Alternative BOM ${delAlt}, Usage ${delUsage})`;
            const preview = {
              entityKey: 'bom',
              entityLabel: 'Bill of Materials',
              summary,
              material: delMat,
              plant: delPlant,
              alternativeBom: delAlt,
              bomUsage: delUsage,
              riskLevel: 3,
              warning: `You are about to delete BOM: Material: ${delMat}, Plant: ${delPlant}, Alternative BOM: ${delAlt}, BOM Usage: ${delUsage}. This will permanently delete the selected BOM. Do you want to proceed?`,
              fields: {
                'Material': delMat,
                'Plant': delPlant,
                'Alternative BOM': delAlt,
                'BOM Usage': delUsage
              }
            };
            const payload = { material: delMat, plant: delPlant, alternativeBom: delAlt, bomUsage: delUsage };
            const pending = pendingActionStore.createPendingAction({
              type: 'delete_bom',
              entityKey: 'bom',
              recordId: `${delMat}-${delPlant}-${delAlt}`,
              payload,
              preview,
              riskLevel: 3,
              sapUsername: username,
              expectedSapUser: getSelectedSapUser() || username || null,
              selectedSessionId: getSelectedSapSessionId() || null,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'delete_bom',
              entityKey: 'bom',
              summary,
              preview,
              riskLevel: 3,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                summary,
                preview
              })
            });
            continue;
          }

          const validation = validateToolArgs(entityKey, toolArgs);
          if (!validation.valid) {
            console.error('Invalid arguments structure from model:', toolArgs);
            return res.status(200).json({
              reply: 'I had trouble understanding that request — could you rephrase it?',
              data: null,
              error: true
            });
          }

          try {
            const queryPayload = validation.filters.length > 0
              ? { filters: validation.filters, top: toolArgs.top, skip: toolArgs.skip }
              : { ...(validation.legacyArgs || {}), top: toolArgs.top, skip: toolArgs.skip };

            const entityResponse = await getEntityData(entityKey, queryPayload, credentials, activeSystem);
            const records = entityResponse.d?.results || (Array.isArray(entityResponse) ? entityResponse : []);
            combinedRecords = combinedRecords.concat(records);

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify(records.slice(0, 30))
            });
          } catch (entityErr) {
            console.error(`Error in getEntityData (${entityKey}):`, entityErr.message);
            return res.status(200).json({
              reply: `Encountered an error fetching records for ${schema?.label || entityKey}.`,
              data: null,
              error: true
            });
          }
        }

        // TOOL 2: propose_update_entity_record (or legacy propose_update_business_partner)
        else if (fnName === 'propose_update_entity_record' || fnName === 'propose_update_business_partner') {
          try {
            const entityKey = resolveEntityKey(toolArgs.entityKey, message);
            const recordId = toolArgs.recordId || toolArgs.businessPartnerId;
            const { changes } = toolArgs;
            const schema = getEntitySchema(entityKey);
            activeEntitySchema = schema;

            if (!recordId) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({ error: `recordId is required to propose an update.` })
              });
              continue;
            }

            // 1. Explicitly fetch the FULL current record by ID from mock/live data source
            let currentRecord = null;
            try {
              currentRecord = await getEntityRecordById(entityKey, recordId, credentials, activeSystem);
            } catch (lookupErr) {
              console.warn(`[chat.js] Direct getEntityRecordById lookup failed for ${entityKey} #${recordId}:`, lookupErr.message);
            }

            if (!currentRecord) {
              try {
                const entityRes = await getEntityData(
                  entityKey,
                  { filters: [{ column: schema.idField, operator: 'eq', value: String(recordId).trim() }] },
                  credentials,
                  activeSystem
                );
                const records = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
                if (records.length > 0) {
                  currentRecord = records[0];
                }
              } catch (fetchErr) {
                console.warn(`[chat.js] Exact ID lookup failed for ${entityKey} #${recordId}:`, fetchErr.message);
              }
            }

            if (!currentRecord) {
              if (process.env.USE_MOCK_SAP === 'false' && !credentials) {
                return res.status(200).json({
                  reply: '⚠️ SAP credentials are required to fetch and update records in real mode. Please log in with your SAP credentials.',
                  data: null,
                  error: true
                });
              }

              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({ error: `${schema?.singularLabel || schema?.label || entityKey} with ID "${recordId}" does not exist.` })
              });
              continue;
            }

            const validation = validateUpdateChanges(entityKey, changes);
            if (!validation.valid) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({ error: `Validation errors: ${validation.errors.join('; ')}` })
              });
              continue;
            }

            // 2. Build diff preview populating currentValue using actual existing field values from record
            const currentValues = {};
            const proposedValues = {};
            const changedFields = [];

            for (const [key, val] of Object.entries(validation.normalizedChanges)) {
              const curVal = getRecordColumnValue(entityKey, currentRecord, key);
              const colDef = getColumnByName(entityKey, key);

              currentValues[key] = curVal;
              proposedValues[key] = val;

              changedFields.push({
                field: key,
                fieldLabel: colDef?.label || key,
                current: curVal,
                currentValue: curVal,
                proposed: val,
                proposedValue: val
              });
            }

            const recordName = getRecordColumnValue(entityKey, currentRecord, schema.nameField) || currentRecord[schema.nameField] || '';
            const preview = {
              entityKey,
              entityLabel: schema.singularLabel,
              recordId: String(recordId).trim(),
              businessPartnerId: String(recordId).trim(),
              recordName,
              businessPartnerName: recordName,
              currentValues,
              proposedValues,
              changedFields
            };

            const pending = pendingActionStore.createPendingAction({
              type: 'update',
              entityKey,
              recordId: String(recordId).trim(),
              businessPartnerId: String(recordId).trim(),
              payload: validation.normalizedChanges,
              preview,
              sapUsername: username,
              sourcePrompt: message.trim(),
              systemKey: activeSystem
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'update',
              entityKey,
              preview,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                preview
              })
            });
          } catch (proposeErr) {
            console.error('Error in propose_update_entity_record:', proposeErr);
            return res.status(200).json({
              reply: `⚠️ Unable to propose update: ${proposeErr.message || 'Operation failed'}`,
              data: null,
              error: true
            });
          }
        }

        // TOOL 3: propose_create_entity_record (or legacy propose_create_business_partner)
        else if (fnName === 'propose_create_entity_record' || fnName === 'propose_create_business_partner') {
          try {
            const entityKey = resolveEntityKey(toolArgs.entityKey, message);
            const schema = getEntitySchema(entityKey);
            activeEntitySchema = schema;

            const fields = (toolArgs.fields && typeof toolArgs.fields === 'object') ? toolArgs.fields : { ...toolArgs };
            delete fields.entityKey;

            // If copy-from intent is detected, route seamlessly to copy_bom
            const copyFromIntent = message.match(/(?:copying|copy)\s+(?:a\s+BOM\s+)?(?:for\s+([A-Za-z0-9_-]+)\s+)?(?:in\s+plant\s+([A-Za-z0-9_-]+)\s+)?from\s+(?:plant\s+)?([A-Za-z0-9_-]+)/i);
            if (entityKey === 'bom' && (fields.copyFrom || fields.sourceReference || fields.sourcePlant || copyFromIntent)) {
              const extracted = extractCopyBomParamsFromText(message);
              const srcMat = String(fields.sourceMaterial || fields.copyFrom?.material || fields.sourceReference?.material || extracted.material || fields.material || copyFromIntent?.[1] || '').trim();
              const srcPlant = String(fields.sourcePlant || fields.copyFrom?.plant || fields.sourceReference?.plant || extracted.sourcePlant || copyFromIntent?.[3] || '').trim();
              const tgtMat = String(fields.material || extracted.material || copyFromIntent?.[1] || srcMat).trim();
              const tgtPlant = String(fields.plant || extracted.targetPlant || copyFromIntent?.[2] || '').trim();
              const srcUsage = String(fields.sourceUsage || fields.copyFrom?.bomUsage || fields.sourceReference?.bomUsage || fields.bomUsage || '1').trim();
              const tgtUsage = String(fields.bomUsage || fields.targetUsage || '1').trim();

              if (srcPlant && tgtPlant && tgtMat) {
                const validation = await validateCopyBomParameters({
                  sourceMaterial: srcMat,
                  sourcePlant: srcPlant,
                  sourceUsage: srcUsage,
                  targetMaterial: tgtMat,
                  targetPlant: tgtPlant,
                  targetUsage: tgtUsage
                });

                if (!validation.valid) {
                  return res.status(200).json({
                    reply: validation.message,
                    data: null,
                    proposedAction: null,
                    entityKey: 'bom',
                    schema: schema || getEntitySchema('bom') || null,
                    error: validation.code !== 'MISSING_FIELDS'
                  });
                }

                const clean = validation.cleanParams;
                const summary = `Copy BOM from Material ${clean.sourceMaterial} Plant ${clean.sourcePlant} Usage ${clean.sourceUsage} → to Material ${clean.targetMaterial} Plant ${clean.targetPlant} Usage ${clean.targetUsage}`;

                const preview = {
                  entityKey: 'bom',
                  entityLabel: 'Bill of Materials',
                  summary,
                  sourceMaterial: clean.sourceMaterial,
                  sourcePlant: clean.sourcePlant,
                  sourceUsage: clean.sourceUsage,
                  sourceAltBom: clean.sourceAltBom,
                  targetMaterial: clean.targetMaterial,
                  targetPlant: clean.targetPlant,
                  targetUsage: clean.targetUsage,
                  targetAltBom: clean.targetAltBom,
                  fields: {
                    'Target Material': clean.targetMaterial,
                    'Target Plant': clean.targetPlant,
                    'Target Usage': clean.targetUsage,
                    'Target Alternative BOM': clean.targetAltBom || 'Auto-select',
                    'Source Material': clean.sourceMaterial,
                    'Source Plant': clean.sourcePlant,
                    'Source Usage': clean.sourceUsage,
                    'Source Alternative BOM': clean.sourceAltBom || 'Default'
                  }
                };

                const payload = {
                  source: { material: clean.sourceMaterial, plant: clean.sourcePlant, bomUsage: clean.sourceUsage, alternativeBom: clean.sourceAltBom },
                  target: { material: clean.targetMaterial, plant: clean.targetPlant, bomUsage: clean.targetUsage, alternativeBom: clean.targetAltBom },
                  sourceComponents: clean.sourceComponents || [],
                  availableAlternatives: validation.availableAlternatives || []
                };

                const pending = pendingActionStore.createPendingAction({
                  type: 'copy_bom',
                  entityKey: 'bom',
                  recordId: clean.targetMaterial,
                  payload,
                  preview,
                  sapUsername: username,
                  expectedSapUser: getSelectedSapUser() || username || null,
                  selectedSessionId: getSelectedSapSessionId() || null,
                  sourcePrompt: message.trim()
                });

                pendingActionToReturn = {
                  actionId: pending.actionId,
                  type: 'copy_bom',
                  entityKey: 'bom',
                  summary,
                  preview,
                  expiresAt: pending.expiresAt
                };

                toolMessages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  name: fnName,
                  content: JSON.stringify({
                    status: 'proposed_waiting_human_confirmation',
                    actionId: pending.actionId,
                    summary,
                    preview
                  })
                });
                continue;
              }
            }

            const validation = validateCreateFields(entityKey, fields);
            if (!validation.valid) {
              console.warn(`[chat.js] propose_create_entity_record validation failed for ${entityKey}:`, validation.errors);

              const missingFieldErrors = validation.errors.filter((e) => e.startsWith('Missing required field:'));
              let replyMsg = '';
              const entLabel = schema?.singularLabel || schema?.label || entityKey;

              if (missingFieldErrors.length > 0) {
                const missingLabels = missingFieldErrors.map((e) => {
                  const match = e.match(/\(([^)]+)\)/);
                  return match ? match[1] : e.replace('Missing required field: ', '');
                });

                if (entityKey === 'bom') {
                  replyMsg = `To create a new Bill of Materials, please provide the missing required field(s): ${missingLabels.join(', ')} (e.g. component item and quantity).`;
                } else {
                  replyMsg = `To create a new ${entLabel}, please provide the missing required field(s): ${missingLabels.join(', ')}.`;
                }
              } else {
                replyMsg = `I couldn't prepare the create proposal for ${entLabel} due to: ${validation.errors.join('; ')}`;
              }

              return res.status(200).json({
                reply: replyMsg,
                data: null,
                entityKey: schema?.entityKey || entityKey,
                schema: schema || null,
                proposedAction: null,
                error: false
              });
            }

            const preview = {
              entityKey,
              entityLabel: schema?.singularLabel || entityKey,
              fields: validation.normalizedFields
            };

            const pending = pendingActionStore.createPendingAction({
              type: 'create',
              entityKey,
              payload: validation.normalizedFields,
              preview,
              sapUsername: username,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'create',
              entityKey,
              preview,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                preview
              })
            });
          } catch (createErr) {
            console.error(`[chat.js] Error in propose_create_entity_record:`, createErr);
            return res.status(200).json({
              reply: `⚠️ Unable to propose create: ${createErr.message || 'Operation failed'}`,
              data: null,
              entityKey: activeEntitySchema?.entityKey || null,
              schema: activeEntitySchema || null,
              error: true
            });
          }
        }

        // TOOL 3b: propose_copy_bom
        else if (fnName === 'propose_copy_bom') {
          try {
            const extracted = extractCopyBomParamsFromText(message);
            const copyFromIntent = message.match(/(?:copying|copy)\s+(?:a\s+BOM\s+)?(?:for\s+([A-Za-z0-9_-]+)\s+)?(?:in\s+plant\s+([A-Za-z0-9_-]+)\s+)?from\s+(?:plant\s+)?([A-Za-z0-9_-]+)/i);

            const sourceMaterial = String(toolArgs.sourceMaterial || toolArgs.source_material || extracted.material || copyFromIntent?.[1] || '').trim();
            const sourcePlant = String(toolArgs.sourcePlant || toolArgs.source_plant || extracted.sourcePlant || copyFromIntent?.[3] || '').trim();
            const sourceUsage = String(toolArgs.sourceUsage || toolArgs.source_usage || '1').trim();
            const targetMaterial = String(toolArgs.targetMaterial || toolArgs.target_material || extracted.material || copyFromIntent?.[1] || sourceMaterial).trim();
            const targetPlant = String(toolArgs.targetPlant || toolArgs.target_plant || extracted.targetPlant || copyFromIntent?.[2] || '').trim();
            const targetUsage = String(toolArgs.targetUsage || toolArgs.target_usage || '1').trim();
            const sourceAltBom = toolArgs.sourceAltBom ? String(toolArgs.sourceAltBom).trim() : '';
            const targetAltBom = toolArgs.targetAltBom ? String(toolArgs.targetAltBom).trim() : '';
            const validFrom = toolArgs.validFrom ? String(toolArgs.validFrom).trim() : '';

            const schema = getEntitySchema('bom');
            activeEntitySchema = schema;

            const validation = await validateCopyBomParameters({
              sourceMaterial,
              sourcePlant,
              sourceUsage,
              sourceAltBom,
              targetMaterial,
              targetPlant,
              targetUsage,
              targetAltBom
            });

            if (!validation.valid) {
              return res.status(200).json({
                reply: validation.message,
                data: null,
                proposedAction: null,
                entityKey: 'bom',
                schema: schema || null,
                error: validation.code !== 'MISSING_FIELDS'
              });
            }

            const clean = validation.cleanParams;
            const summary = `Copy BOM from Material ${clean.sourceMaterial} Plant ${clean.sourcePlant} Usage ${clean.sourceUsage} → to Material ${clean.targetMaterial} Plant ${clean.targetPlant} Usage ${clean.targetUsage}`;

            const preview = {
              entityKey: 'bom',
              entityLabel: 'Bill of Materials',
              summary,
              sourceMaterial: clean.sourceMaterial,
              sourcePlant: clean.sourcePlant,
              sourceUsage: clean.sourceUsage,
              sourceAltBom: clean.sourceAltBom,
              targetMaterial: clean.targetMaterial,
              targetPlant: clean.targetPlant,
              targetUsage: clean.targetUsage,
              targetAltBom: clean.targetAltBom,
              validFrom,
              fields: {
                'Target Material': clean.targetMaterial,
                'Target Plant': clean.targetPlant,
                'Target Usage': clean.targetUsage,
                'Target Alternative BOM': clean.targetAltBom || 'Auto-select',
                'Source Material': clean.sourceMaterial,
                'Source Plant': clean.sourcePlant,
                'Source Usage': clean.sourceUsage,
                'Source Alternative BOM': clean.sourceAltBom || 'Default',
                ...(validFrom ? { 'Valid From': validFrom } : {})
              }
            };

            const payload = {
              source: {
                material: clean.sourceMaterial,
                plant: clean.sourcePlant,
                bomUsage: clean.sourceUsage,
                alternativeBom: clean.sourceAltBom
              },
              target: {
                material: clean.targetMaterial,
                plant: clean.targetPlant,
                bomUsage: clean.targetUsage,
                alternativeBom: clean.targetAltBom,
                validFrom
              },
              sourceComponents: clean.sourceComponents || [],
              availableAlternatives: validation.availableAlternatives || []
            };

            const pending = pendingActionStore.createPendingAction({
              type: 'copy_bom',
              entityKey: 'bom',
              recordId: clean.targetMaterial,
              payload,
              preview,
              sapUsername: username,
              expectedSapUser: getSelectedSapUser() || username || null,
              selectedSessionId: getSelectedSapSessionId() || null,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'copy_bom',
              entityKey: 'bom',
              summary,
              preview,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                summary,
                preview
              })
            });
          } catch (copyErr) {
            console.error(`[chat.js] Error in propose_copy_bom:`, copyErr);
            return res.status(200).json({
              reply: `⚠️ Unable to propose BOM copy: ${copyErr.message || 'Operation failed'}`,
              data: null,
              entityKey: 'bom',
              schema: getEntitySchema('bom') || null,
              error: true
            });
          }
        }

        // TOOL 3c: propose_delete_bom
        else if (fnName === 'propose_delete_bom') {
          try {
            const deleteIntent = message.match(/(?:delete|remove)\s+(?:a\s+)?(?:BOM|bill\s+of\s+materials)\s+(?:for\s+)?([A-Za-z0-9_-]+)?.*?(?:plant\s+([A-Za-z0-9_-]+))?.*?(?:alt(?:ernative)?\s*(?:BOM)?\s*(\d+))?/i);

            const material = String(toolArgs.material || toolArgs.matnr || deleteIntent?.[1] || '').trim().toUpperCase();
            const plant = String(toolArgs.plant || toolArgs.werks || deleteIntent?.[2] || '').trim().toUpperCase();
            const alternativeBom = String(toolArgs.alternativeBom || toolArgs.stlal || toolArgs.altBom || deleteIntent?.[3] || '1').trim();
            const bomUsage = String(toolArgs.bomUsage || toolArgs.stlan || '1').trim();

            if (!material || !plant) {
              return res.status(200).json({
                reply: 'To propose deleting a BOM, please provide the material number, plant code, and alternative BOM.',
                data: null,
                proposedAction: null,
                error: false
              });
            }

            const useRfc = process.env.SAP_BOM_MODE !== 'GUI' && process.env.USE_MOCK_SAP !== 'true';

            if (!useRfc) {
              const preflight = await ensureSapSession();
              if (!preflight.ok) {
                return res.status(200).json({
                  reply: `Cannot propose deleting BOM: ${preflight.message}`,
                  data: null,
                  proposedAction: null,
                  entityKey: 'bom',
                  schema: getEntitySchema('bom'),
                  error: true,
                  code: preflight.status === 'SERVER_UNAVAILABLE' ? 'SAP_SERVER_UNAVAILABLE' : (preflight.code || 'SAP_SESSION_NOT_FOUND'),
                  status: preflight.status
                });
              }
            }

            const bomCheck = useRfc
              ? await rfcReadBom({
                  material,
                  plant,
                  bomUsage,
                  alternativeBom
                })
              : await verifyBomInCs03({
                  material,
                  plant,
                  bomUsage,
                  alternativeBom
                });

            if (!bomCheck.success) {
              return res.status(200).json({
                reply: `Cannot verify BOM before deletion: ${bomCheck.message || 'SAP connection error.'} Workflow stopped.`,
                data: null,
                proposedAction: null,
                entityKey: 'bom',
                schema: getEntitySchema('bom'),
                error: true,
                code: bomCheck.code || 'SAP_SESSION_NOT_FOUND',
                status: bomCheck.status
              });
            }

            const bomExists = bomCheck.bomExists ?? bomCheck.exists;
            if (!bomExists) {
              const alts = bomCheck.availableAlternatives || [];
              const isAltNotFound = alts.length > 0 && !alts.includes(alternativeBom.padStart(2, '0')) && !alts.includes(alternativeBom);
              const failMsg = isAltNotFound
                ? `Alternative BOM ${alternativeBom} does not exist for material ${material} in plant ${plant}. Available alternatives: ${alts.join(', ')}.`
                : (bomCheck.message || `No BOM found for material ${material} in plant ${plant} with usage ${bomUsage}.`);

              return res.status(200).json({
                reply: `Cannot delete BOM: ${failMsg}`,
                data: null,
                proposedAction: null,
                entityKey: 'bom',
                schema: getEntitySchema('bom'),
                error: true,
                code: isAltNotFound ? 'ALTERNATIVE_NOT_FOUND' : 'BOM_NOT_FOUND'
              });
            }

            const schema = getEntitySchema('bom');
            activeEntitySchema = schema;

            const summary = `Delete BOM for Material ${material} in Plant ${plant} (Alternative BOM ${alternativeBom}, Usage ${bomUsage})`;

            const preview = {
              entityKey: 'bom',
              entityLabel: 'Bill of Materials',
              summary,
              material,
              plant,
              alternativeBom,
              bomUsage,
              riskLevel: 3,
              warning: `You are about to delete BOM: Material: ${material}, Plant: ${plant}, Alternative BOM: ${alternativeBom}, BOM Usage: ${bomUsage}. This will permanently delete the selected BOM. Do you want to proceed?`,
              fields: {
                'Material': material,
                'Plant': plant,
                'Alternative BOM': alternativeBom,
                'BOM Usage': bomUsage
              }
            };

            const payload = {
              material,
              plant,
              alternativeBom,
              bomUsage
            };

            const pending = pendingActionStore.createPendingAction({
              type: 'delete_bom',
              entityKey: 'bom',
              recordId: `${material}-${plant}-${alternativeBom}`,
              payload,
              preview,
              riskLevel: 3,
              sapUsername: username,
              expectedSapUser: getSelectedSapUser() || username || null,
              selectedSessionId: getSelectedSapSessionId() || null,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'delete_bom',
              entityKey: 'bom',
              summary,
              preview,
              riskLevel: 3,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                summary,
                preview
              })
            });
          } catch (deleteErr) {
            console.error(`[chat.js] Error in propose_delete_bom:`, deleteErr);
            return res.status(200).json({
              reply: `⚠️ Unable to propose BOM deletion: ${deleteErr.message || 'Operation failed'}`,
              data: null,
              entityKey: 'bom',
              schema: getEntitySchema('bom') || null,
              error: true
            });
          }
        }

        // TOOL 4: propose_delete_entity_record (or legacy propose_delete_business_partner)
        else if (fnName === 'propose_delete_entity_record' || fnName === 'propose_delete_business_partner') {
          try {
            const entityKey = resolveEntityKey(toolArgs.entityKey, message);
            const recordId = toolArgs.recordId || toolArgs.businessPartnerId;
            const schema = getEntitySchema(entityKey);
            activeEntitySchema = schema;

            // Guardrail: if entityKey is bom, route directly to delete_bom
            if (entityKey === 'bom') {
              const plantMatch = message.match(/plant\s+([A-Za-z0-9_-]+)/i);
              const altMatch = message.match(/alt(?:ernative)?(?:\s*BOM)?\s*(\d+)/i);
              const delMat = String(recordId || 'A1BH0214C').trim();
              const delPlant = plantMatch?.[1] || toolArgs.plant || '1001';
              const delAlt = altMatch?.[1] || toolArgs.alternativeBom || '2';
              const delUsage = toolArgs.bomUsage || '1';

              const summary = `Delete BOM for Material ${delMat} in Plant ${delPlant} (Alternative BOM ${delAlt}, Usage ${delUsage})`;
              const preview = {
                entityKey: 'bom',
                entityLabel: 'Bill of Materials',
                summary,
                material: delMat,
                plant: delPlant,
                alternativeBom: delAlt,
                bomUsage: delUsage,
                riskLevel: 3,
                warning: `You are about to delete BOM: Material: ${delMat}, Plant: ${delPlant}, Alternative BOM: ${delAlt}, BOM Usage: ${delUsage}. This will permanently delete the selected BOM. Do you want to proceed?`,
                fields: {
                  'Material': delMat,
                  'Plant': delPlant,
                  'Alternative BOM': delAlt,
                  'BOM Usage': delUsage
                }
              };
              const payload = { material: delMat, plant: delPlant, alternativeBom: delAlt, bomUsage: delUsage };
              const pending = pendingActionStore.createPendingAction({
                type: 'delete_bom',
                entityKey: 'bom',
                recordId: `${delMat}-${delPlant}-${delAlt}`,
                payload,
                preview,
                riskLevel: 3,
                sapUsername: username,
                expectedSapUser: getSelectedSapUser() || username || null,
                selectedSessionId: getSelectedSapSessionId() || null,
                sourcePrompt: message.trim()
              });

              pendingActionToReturn = {
                actionId: pending.actionId,
                type: 'delete_bom',
                entityKey: 'bom',
                summary,
                preview,
                riskLevel: 3,
                expiresAt: pending.expiresAt
              };

              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({
                  status: 'proposed_waiting_human_confirmation',
                  actionId: pending.actionId,
                  summary,
                  preview
                })
              });
              continue;
            }

            if (!recordId) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({ error: 'recordId is required to propose deletion.' })
              });
              continue;
            }

            let currentRecord = null;
            try {
              currentRecord = await getEntityRecordById(entityKey, recordId, credentials, activeSystem);
            } catch (lookupErr) {
              console.warn(`[chat.js] Direct getEntityRecordById lookup failed for ${entityKey} #${recordId}:`, lookupErr.message);
            }

            if (!currentRecord) {
              try {
                const entityRes = await getEntityData(
                  entityKey,
                  { filters: [{ column: schema.idField, operator: 'eq', value: String(recordId).trim() }] },
                  credentials,
                  activeSystem
                );
                const records = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
                if (records.length > 0) {
                  currentRecord = records[0];
                }
              } catch (fetchErr) {
                console.warn(`[chat.js] Exact ID lookup failed for ${entityKey} #${recordId}:`, fetchErr.message);
              }
            }

            if (!currentRecord) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: fnName,
                content: JSON.stringify({ error: `${schema.singularLabel} with ID "${recordId}" does not exist.` })
              });
              continue;
            }

            const recordName = getRecordColumnValue(entityKey, currentRecord, schema.nameField) || currentRecord[schema.nameField] || '';
            const cityVal = getRecordColumnValue(entityKey, currentRecord, 'City');
            const countryVal = getRecordColumnValue(entityKey, currentRecord, 'Country');
            const preview = {
              entityKey,
              entityLabel: schema.singularLabel,
              recordId: String(recordId).trim(),
              businessPartnerId: String(recordId).trim(),
              recordName,
              businessPartnerName: recordName,
              city: cityVal,
              country: countryVal,
              record: currentRecord
            };

            const pending = pendingActionStore.createPendingAction({
              type: 'delete',
              entityKey,
              recordId: String(recordId).trim(),
              businessPartnerId: String(recordId).trim(),
              payload: {},
              preview,
              sapUsername: username,
              sourcePrompt: message.trim()
            });

            pendingActionToReturn = {
              actionId: pending.actionId,
              type: 'delete',
              entityKey,
              preview,
              expiresAt: pending.expiresAt
            };

            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                status: 'proposed_waiting_human_confirmation',
                actionId: pending.actionId,
                preview
              })
            });
          } catch (delErr) {
            console.error(`[chat.js] Error in propose_delete_entity_record:`, delErr);
            return res.status(200).json({
              reply: `⚠️ Unable to propose deletion: ${delErr.message || 'Operation failed'}`,
              data: null,
              entityKey: activeEntitySchema?.entityKey || null,
              schema: activeEntitySchema || null,
              error: true
            });
          }
        }

        // TOOL 6: check_failed_jobs
        else if (fnName === 'check_failed_jobs') {
          const entityKey = 'backgroundJob';
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;
          const top = toolArgs?.top || 50;

          const entityRes = await getEntityData(entityKey, {
            filters: [{ column: 'status', operator: 'eq', value: 'CANCELLED' }],
            top
          }, credentials);

          const failedJobs = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
          combinedRecords = combinedRecords.concat(failedJobs);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(failedJobs.map((j) => ({
              jobId: j.jobId,
              jobName: j.jobName,
              status: j.status,
              startTime: j.startTime,
              endTime: j.endTime,
              executedBy: j.executedBy,
              retryCount: j.retryCount,
              latestError: j.jobLog?.filter((l) => l.severity === 'ERROR')?.slice(-1)?.[0]?.message || 'Unknown error'
            })))
          });
        }

        // TOOL 7: read_job_log
        else if (fnName === 'read_job_log') {
          const jobId = toolArgs?.jobId;
          const schema = getEntitySchema('backgroundJob');
          activeEntitySchema = schema;

          let targetJob = await safeGetEntityRecord('backgroundJob', jobId, credentials, activeSystem);
          if (!targetJob) {
            const allJobs = getMockDataCache('backgroundJob');
            targetJob = allJobs.find(
              (j) => j.jobName?.toLowerCase() === String(jobId).trim().toLowerCase()
            );
          }

          if (!targetJob) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `Background job "${jobId}" not found in SAP system.` })
            });
            continue;
          }

          const logs = targetJob.jobLog || [];
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              jobId: targetJob.jobId,
              jobName: targetJob.jobName,
              status: targetJob.status,
              logCount: logs.length,
              logs
            })
          });
        }

        // TOOL 8: diagnose_job_failure
        else if (fnName === 'diagnose_job_failure') {
          const jobId = toolArgs?.jobId;
          const schema = getEntitySchema('backgroundJob');
          activeEntitySchema = schema;

          let targetJob = await safeGetEntityRecord('backgroundJob', jobId, credentials, activeSystem);
          if (!targetJob) {
            const allJobs = getMockDataCache('backgroundJob');
            targetJob = allJobs.find(
              (j) => j.jobName?.toLowerCase() === String(jobId).trim().toLowerCase()
            );
          }

          if (!targetJob) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `Background job "${jobId}" not found for diagnosis.` })
            });
            continue;
          }

          const diagnosis = classifyError(targetJob.jobLog);
          if (diagnosis?.category) {
            recordErrorOccurrence(diagnosis.category, false);
          }
          const riskDef = getRiskLevel(diagnosis.riskLevel);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              jobId: targetJob.jobId,
              jobName: targetJob.jobName,
              status: targetJob.status,
              category: diagnosis.category,
              recommendedAction: diagnosis.recommendedAction,
              riskLevel: diagnosis.riskLevel,
              riskName: riskDef.name,
              description: diagnosis.description,
              matchedMessage: diagnosis.matchedMessage,
              occurrenceCount: diagnosis.occurrenceCount || 0,
              successfulResolutionCount: diagnosis.successfulResolutionCount || 0,
              lastSeen: diagnosis.lastSeen || null,
              isRecoverable: diagnosis.recommendedAction === 'RETRY' && diagnosis.riskLevel <= 2,
              requiresConfirmation: riskDef.requiresConfirmation
            })
          });
        }

        // TOOL 9: propose_retry_job
        else if (fnName === 'propose_retry_job') {
          const jobId = toolArgs?.jobId;
          const schema = getEntitySchema('backgroundJob');
          activeEntitySchema = schema;

          let targetJob = await safeGetEntityRecord('backgroundJob', jobId, credentials, activeSystem);
          if (!targetJob) {
            const allJobs = getMockDataCache('backgroundJob');
            targetJob = allJobs.find(
              (j) => j.jobName?.toLowerCase() === String(jobId).trim().toLowerCase()
            );
          }

          if (!targetJob) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `Background job "${jobId}" not found in SAP system.` })
            });
            continue;
          }

          if (targetJob.status !== 'CANCELLED') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `Job "${targetJob.jobId}" (${targetJob.jobName}) is currently in status "${targetJob.status}". Only CANCELLED jobs can be retried.`
              })
            });
            continue;
          }

          // Safety gate: diagnose before proposing retry
          const diagnosis = classifyError(targetJob.jobLog);
          if (diagnosis.recommendedAction !== 'RETRY' || diagnosis.riskLevel > 2) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `SAFETY GATE: Cannot propose retry for job "${targetJob.jobId}" (${targetJob.jobName}). Error category "${diagnosis.category}" (Risk Level ${diagnosis.riskLevel}) requires human escalation. ${diagnosis.description}`
              })
            });
            continue;
          }

          const preview = {
            entityKey: 'backgroundJob',
            entityLabel: 'Background Job',
            recordId: targetJob.jobId,
            jobId: targetJob.jobId,
            jobName: targetJob.jobName,
            currentStatus: targetJob.status,
            proposedStatus: 'RUNNING -> FINISHED',
            currentRetryCount: targetJob.retryCount || 0,
            proposedRetryCount: (targetJob.retryCount || 0) + 1,
            diagnosis: {
              category: diagnosis.category,
              recommendedAction: diagnosis.recommendedAction,
              riskLevel: diagnosis.riskLevel,
              description: diagnosis.description,
              matchedMessage: diagnosis.matchedMessage
            }
          };

          const pending = pendingActionStore.createPendingAction({
            type: 'retry',
            entityKey: 'backgroundJob',
            recordId: targetJob.jobId,
            payload: { jobId: targetJob.jobId },
            category: diagnosis.category,
            systemKey,
            preview,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'retry',
            entityKey: 'backgroundJob',
            category: diagnosis.category,
            systemKey,
            riskLevel: 2,
            requiresReason: false,
            preview,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 10: check_failed_idocs
        else if (fnName === 'check_failed_idocs') {
          const entityKey = 'idoc';
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;
          const top = toolArgs?.top || 50;

          const entityRes = await getEntityData(entityKey, {
            filters: [{ column: 'status', operator: 'eq', value: '51-Error' }],
            top
          }, credentials);

          const failedIdocs = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
          combinedRecords = combinedRecords.concat(failedIdocs);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(failedIdocs.map((item) => ({
              idocNumber: item.idocNumber,
              idocType: item.idocType,
              direction: item.direction,
              status: item.status,
              partner: item.partner,
              createdAt: item.createdAt,
              latestError: item.errorLog?.[item.errorLog.length - 1]?.message || 'No error log recorded'
            })))
          });
        }

        // TOOL 11: read_idoc_detail
        else if (fnName === 'read_idoc_detail') {
          const idocNumber = toolArgs?.idocNumber;
          const schema = getEntitySchema('idoc');
          activeEntitySchema = schema;

          let targetIdoc = await safeGetEntityRecord('idoc', idocNumber, credentials, activeSystem);
          if (!targetIdoc) {
            const allIdocs = getMockDataCache('idoc');
            targetIdoc = allIdocs.find(
              (i) => String(i.idocNumber).trim().toLowerCase() === String(idocNumber).trim().toLowerCase()
            );
          }

          if (!targetIdoc) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `IDoc "${idocNumber}" not found in SAP IDoc system.` })
            });
            continue;
          }

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              idocNumber: targetIdoc.idocNumber,
              idocType: targetIdoc.idocType,
              direction: targetIdoc.direction,
              status: targetIdoc.status,
              partner: targetIdoc.partner,
              createdAt: targetIdoc.createdAt,
              errorLogCount: targetIdoc.errorLog?.length || 0,
              errorLog: targetIdoc.errorLog || []
            })
          });
        }

        // TOOL 12: diagnose_idoc_failure
        else if (fnName === 'diagnose_idoc_failure') {
          const idocNumber = toolArgs?.idocNumber;
          const schema = getEntitySchema('idoc');
          activeEntitySchema = schema;

          let targetIdoc = await safeGetEntityRecord('idoc', idocNumber, credentials, activeSystem);
          if (!targetIdoc) {
            const allIdocs = getMockDataCache('idoc');
            targetIdoc = allIdocs.find(
              (i) => String(i.idocNumber).trim().toLowerCase() === String(idocNumber).trim().toLowerCase()
            );
          }

          if (!targetIdoc) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `IDoc "${idocNumber}" not found for diagnosis.` })
            });
            continue;
          }

          const diagnosis = classifyError(targetIdoc.errorLog);
          if (diagnosis?.category) {
            recordErrorOccurrence(diagnosis.category, false);
          }
          const riskDef = getRiskLevel(diagnosis.riskLevel);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              idocNumber: targetIdoc.idocNumber,
              idocType: targetIdoc.idocType,
              status: targetIdoc.status,
              category: diagnosis.category,
              recommendedAction: diagnosis.recommendedAction,
              riskLevel: diagnosis.riskLevel,
              riskName: riskDef.name,
              description: diagnosis.description,
              matchedMessage: diagnosis.matchedMessage,
              occurrenceCount: diagnosis.occurrenceCount || 0,
              successfulResolutionCount: diagnosis.successfulResolutionCount || 0,
              lastSeen: diagnosis.lastSeen || null,
              isRecoverable: diagnosis.recommendedAction === 'RETRY' && diagnosis.riskLevel <= 2,
              requiresConfirmation: riskDef.requiresConfirmation
            })
          });
        }

        // TOOL 13: propose_reprocess_idoc
        else if (fnName === 'propose_reprocess_idoc') {
          const idocNumber = toolArgs?.idocNumber;
          const schema = getEntitySchema('idoc');
          activeEntitySchema = schema;

          let targetIdoc = await safeGetEntityRecord('idoc', idocNumber, credentials, activeSystem);
          if (!targetIdoc) {
            const allIdocs = getMockDataCache('idoc');
            targetIdoc = allIdocs.find(
              (i) => String(i.idocNumber).trim().toLowerCase() === String(idocNumber).trim().toLowerCase()
            );
          }

          if (!targetIdoc) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `IDoc "${idocNumber}" not found in SAP system.` })
            });
            continue;
          }

          if (targetIdoc.status !== '51-Error') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `IDoc "${targetIdoc.idocNumber}" is currently in status "${targetIdoc.status}". Only IDocs with status "51-Error" can be reprocessed.`
              })
            });
            continue;
          }

          // Safety gate: diagnose before proposing reprocessing
          const diagnosis = classifyError(targetIdoc.errorLog);
          if (diagnosis.recommendedAction !== 'RETRY' || diagnosis.riskLevel > 2) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `SAFETY GATE: Cannot propose reprocessing for IDoc "${targetIdoc.idocNumber}". Error category "${diagnosis.category}" (Risk Level ${diagnosis.riskLevel}) requires human escalation. ${diagnosis.description}`
              })
            });
            continue;
          }

          const preview = {
            entityKey: 'idoc',
            entityLabel: 'IDoc',
            recordId: targetIdoc.idocNumber,
            idocNumber: targetIdoc.idocNumber,
            idocType: targetIdoc.idocType,
            partner: targetIdoc.partner,
            direction: targetIdoc.direction,
            currentStatus: targetIdoc.status,
            proposedStatus: '53-Successful',
            diagnosis: {
              category: diagnosis.category,
              recommendedAction: diagnosis.recommendedAction,
              riskLevel: diagnosis.riskLevel,
              description: diagnosis.description,
              matchedMessage: diagnosis.matchedMessage
            }
          };

          const pending = pendingActionStore.createPendingAction({
            type: 'reprocess',
            entityKey: 'idoc',
            recordId: targetIdoc.idocNumber,
            payload: { idocNumber: targetIdoc.idocNumber },
            category: diagnosis.category,
            systemKey,
            preview,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'reprocess',
            entityKey: 'idoc',
            category: diagnosis.category,
            systemKey,
            riskLevel: 2,
            requiresReason: false,
            preview,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 14: check_application_logs
        else if (fnName === 'check_application_logs') {
          const entityKey = 'applicationLog';
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;
          const top = toolArgs?.top || 50;

          const filters = [];
          if (toolArgs?.severity) {
            filters.push({ column: 'severity', operator: 'eq', value: String(toolArgs.severity) });
          }
          if (toolArgs?.object) {
            filters.push({ column: 'object', operator: 'eq', value: String(toolArgs.object) });
          }
          if (toolArgs?.transactionCode) {
            filters.push({ column: 'transactionCode', operator: 'eq', value: String(toolArgs.transactionCode) });
          }
          if (toolArgs?.user) {
            filters.push({ column: 'user', operator: 'eq', value: String(toolArgs.user) });
          }

          const entityRes = await getEntityData(entityKey, { filters, top }, credentials);
          const logs = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
          combinedRecords = combinedRecords.concat(logs);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(logs.slice(0, 30))
          });
        }

        // TOOL 15: check_failed_interfaces
        else if (fnName === 'check_failed_interfaces') {
          const entityKey = 'interfaceMonitor';
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;
          const top = toolArgs?.top || 50;

          const entityRes = await getEntityData(entityKey, {
            filters: [{ column: 'status', operator: 'eq', value: 'FAILED' }],
            top
          }, credentials);

          const failedIfaces = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
          combinedRecords = combinedRecords.concat(failedIfaces);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(failedIfaces.map((item) => ({
              interfaceId: item.interfaceId,
              interfaceName: item.interfaceName,
              sourceSystem: item.sourceSystem,
              targetSystem: item.targetSystem,
              status: item.status,
              lastRunTime: item.lastRunTime,
              messageCount: item.messageCount,
              failureReason: item.failureReason
            })))
          });
        }

        // TOOL 16: propose_retrigger_interface
        else if (fnName === 'propose_retrigger_interface') {
          const interfaceId = toolArgs?.interfaceId;
          const schema = getEntitySchema('interfaceMonitor');
          activeEntitySchema = schema;

          let targetIface = await safeGetEntityRecord('interfaceMonitor', interfaceId, credentials, activeSystem);
          if (!targetIface) {
            const allIfaces = getMockDataCache('interfaceMonitor');
            targetIface = allIfaces.find(
              (i) => String(i.interfaceId).trim().toLowerCase() === String(interfaceId).trim().toLowerCase()
            );
          }

          if (!targetIface) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `Interface "${interfaceId}" not found in SAP system.` })
            });
            continue;
          }

          if (targetIface.status !== 'FAILED') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `Interface "${targetIface.interfaceId}" (${targetIface.interfaceName}) is currently in status "${targetIface.status}". Only FAILED interfaces can be retriggered.`
              })
            });
            continue;
          }

          // Safety gate: diagnose failure reason before proposing retrigger
          const diagnosis = classifyError(targetIface.failureReason);
          if (diagnosis.recommendedAction !== 'RETRY' || diagnosis.riskLevel > 2) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({
                error: `SAFETY GATE: Cannot propose retrigger for interface "${targetIface.interfaceId}" (${targetIface.interfaceName}). Error category "${diagnosis.category}" (Risk Level ${diagnosis.riskLevel}) requires human escalation. ${diagnosis.description}`
              })
            });
            continue;
          }

          const preview = {
            entityKey: 'interfaceMonitor',
            entityLabel: 'Interface',
            recordId: targetIface.interfaceId,
            interfaceId: targetIface.interfaceId,
            interfaceName: targetIface.interfaceName,
            sourceSystem: targetIface.sourceSystem,
            targetSystem: targetIface.targetSystem,
            currentStatus: targetIface.status,
            proposedStatus: 'SUCCESS',
            failureReason: targetIface.failureReason,
            diagnosis: {
              category: diagnosis.category,
              recommendedAction: diagnosis.recommendedAction,
              riskLevel: diagnosis.riskLevel,
              description: diagnosis.description,
              matchedMessage: diagnosis.matchedMessage
            }
          };

          if (diagnosis?.category) {
            recordErrorOccurrence(diagnosis.category, false);
          }

          const pending = pendingActionStore.createPendingAction({
            type: 'retrigger',
            entityKey: 'interfaceMonitor',
            recordId: targetIface.interfaceId,
            payload: { interfaceId: targetIface.interfaceId },
            category: diagnosis.category,
            systemKey,
            preview,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'retrigger',
            entityKey: 'interfaceMonitor',
            category: diagnosis.category,
            systemKey,
            riskLevel: 2,
            requiresReason: false,
            preview,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 17: propose_change_master_data (Level 3 Sensitive)
        else if (fnName === 'propose_change_master_data') {
          const entityKey = resolveEntityKey(toolArgs.entityKey, message);
          const recordId = toolArgs.recordId;
          const { changes, reason } = toolArgs;
          const schema = getEntitySchema(entityKey);
          activeEntitySchema = schema;

          if (!recordId) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: 'recordId is required to propose master data change.' })
            });
            continue;
          }

          let currentRecord = await safeGetEntityRecord(entityKey, recordId, credentials, activeSystem);
          if (!currentRecord) {
            try {
              const entityRes = await getEntityData(
                entityKey,
                { filters: [{ column: schema?.idField || 'businessPartnerId', operator: 'eq', value: String(recordId).trim() }] },
                credentials,
                activeSystem
              );
              const records = entityRes?.d?.results || (Array.isArray(entityRes) ? entityRes : []);
              if (records.length > 0) currentRecord = records[0];
            } catch (fetchErr) {
              console.warn(`[chat.js] Exact lookup failed for ${entityKey} #${recordId}:`, fetchErr.message);
            }
          }

          if (!currentRecord) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `${schema?.singularLabel || entityKey} with ID "${recordId}" does not exist in system ${systemKey}.` })
            });
            continue;
          }

          const currentValues = {};
          const proposedValues = {};
          const changedFields = [];

          for (const [key, val] of Object.entries(changes || {})) {
            const curVal = getRecordColumnValue(entityKey, currentRecord, key);
            const colDef = getColumnByName(entityKey, key);
            currentValues[key] = curVal;
            proposedValues[key] = val;
            changedFields.push({
              field: key,
              fieldLabel: colDef?.label || key,
              current: curVal,
              currentValue: curVal,
              proposed: val,
              proposedValue: val
            });
          }

          const recordName = getRecordColumnValue(entityKey, currentRecord, schema?.nameField) || currentRecord[schema?.nameField] || '';
          const preview = {
            actionType: 'CHANGE_MASTER_DATA',
            entityKey,
            entityLabel: schema?.singularLabel || 'Master Data',
            recordId: String(recordId).trim(),
            recordName,
            currentValues,
            proposedValues,
            changedFields,
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            reason: reason || ''
          };

          const pending = pendingActionStore.createPendingAction({
            type: 'change_master_data',
            entityKey,
            recordId: String(recordId).trim(),
            payload: changes,
            preview,
            riskLevel: 3,
            requiresReason: true,
            reason: reason || '',
            systemKey,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'change_master_data',
            entityKey,
            preview,
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              riskLevel: 3,
              requiresReason: true,
              systemKey,
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 18: propose_release_purchase_order (Level 3 Sensitive)
        else if (fnName === 'propose_release_purchase_order') {
          const poNumber = toolArgs.poNumber;
          const reason = toolArgs.reason || '';
          const schema = getEntitySchema('purchaseOrder');
          activeEntitySchema = schema;

          let targetPo = await safeGetEntityRecord('purchaseOrder', poNumber, credentials, activeSystem);
          if (!targetPo) {
            const allPos = getMockDataCache('purchaseOrder');
            targetPo = allPos.find(
              (p) => String(p.poNumber).trim() === String(poNumber).trim()
            );
          }

          if (!targetPo) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: fnName,
              content: JSON.stringify({ error: `Purchase Order "${poNumber}" not found in SAP system (${systemKey}).` })
            });
            continue;
          }

          const preview = {
            actionType: 'RELEASE_PO',
            entityKey: 'purchaseOrder',
            entityLabel: 'Purchase Order',
            recordId: targetPo.poNumber,
            poNumber: targetPo.poNumber,
            vendorName: targetPo.vendorName,
            totalAmount: targetPo.totalAmount,
            currency: targetPo.currency,
            companyCode: targetPo.companyCode,
            purchasingOrg: targetPo.purchasingOrg,
            currentStatus: targetPo.releaseStatus,
            proposedStatus: '02 (Released)',
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            reason
          };

          const pending = pendingActionStore.createPendingAction({
            type: 'release_po',
            entityKey: 'purchaseOrder',
            recordId: targetPo.poNumber,
            payload: { poNumber: targetPo.poNumber },
            preview,
            riskLevel: 3,
            requiresReason: true,
            reason,
            systemKey,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'release_po',
            entityKey: 'purchaseOrder',
            preview,
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              riskLevel: 3,
              requiresReason: true,
              systemKey,
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 19: propose_post_financial_document (Level 3 Sensitive)
        else if (fnName === 'propose_post_financial_document') {
          const { companyCode = '1000', documentType = 'SA', currency = 'USD', headerText = '', items = [], reason = '' } = toolArgs;
          const schema = getEntitySchema('financialDocument');
          activeEntitySchema = schema;

          let totalDebit = 0;
          let totalCredit = 0;
          for (const it of items) {
            const amt = Number(it.amount) || 0;
            if (['S', 'D'].includes(String(it.debitCredit).toUpperCase())) {
              totalDebit += amt;
            } else {
              totalCredit += amt;
            }
          }

          const preview = {
            actionType: 'POST_FI_DOC',
            entityKey: 'financialDocument',
            entityLabel: 'Financial Document',
            recordId: 'NEW_FI_DOC',
            companyCode,
            documentType,
            currency,
            headerText,
            items,
            totalDebit,
            totalCredit,
            isBalanced: Math.abs(totalDebit - totalCredit) < 0.001,
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            reason
          };

          const pending = pendingActionStore.createPendingAction({
            type: 'post_fi_doc',
            entityKey: 'financialDocument',
            recordId: 'NEW_FI_DOC',
            payload: { companyCode, documentType, currency, headerText, items },
            preview,
            riskLevel: 3,
            requiresReason: true,
            reason,
            systemKey,
            sapUsername: username,
            sourcePrompt: message.trim()
          });

          pendingActionToReturn = {
            actionId: pending.actionId,
            type: 'post_fi_doc',
            entityKey: 'financialDocument',
            preview,
            riskLevel: 3,
            requiresReason: true,
            systemKey,
            expiresAt: pending.expiresAt
          };

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify({
              status: 'proposed_waiting_human_confirmation',
              riskLevel: 3,
              requiresReason: true,
              systemKey,
              actionId: pending.actionId,
              preview
            })
          });
        }

        // TOOL 5: execute_confirmed_action (Protected)
        else if (fnName === 'execute_confirmed_action') {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: 'execute_confirmed_action',
            content: JSON.stringify({
              error: 'DIRECT EXECUTION PROHIBITED: Writes can ONLY execute when the human user clicks the Confirm button in the UI.'
            })
          });
        }

        // TOOL: check_material_maintenance (Read-Only)
        else if (fnName === 'check_material_maintenance') {
          const plant = toolArgs?.plant;
          let matList = Array.isArray(toolArgs?.materials)
            ? toolArgs.materials
            : (toolArgs?.materials ? [toolArgs.materials] : (toolArgs?.material ? [toolArgs.material] : []));
          const bomMat = toolArgs?.bomMaterial;
          const bomUsage = toolArgs?.bomUsage || '1';

          if (bomMat && matList.length === 0) {
            try {
              const bomRes = await verifyBomInCs03({
                material: bomMat,
                plant: String(plant || '').trim(),
                bomUsage: String(bomUsage).trim()
              });
              const comps = bomRes.components || [];
              matList = [bomMat, ...comps.map((c) => c.material || c.component).filter(Boolean)];
            } catch {
              matList = [bomMat];
            }
          }

          const resData = await checkMaterialMaintenance(matList, plant);
          materialCheckResults = resData;

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(resData)
          });
        }
      }

      // Default fallback message if OpenRouter Call #2 fails
      let finalReply = '';
      if (pendingActionToReturn) {
        const entLabel = pendingActionToReturn.preview.entityLabel || 'record';
        const recId = pendingActionToReturn.preview.recordId || '';
        if (pendingActionToReturn.type === 'delete') {
          finalReply = `I've prepared a proposal to delete ${entLabel} ${recId}. Please review the danger warning and confirm below.`;
        } else if (pendingActionToReturn.type === 'create') {
          finalReply = `I've prepared a proposal to create a new ${entLabel}. Please review the details and confirm below.`;
        } else if (pendingActionToReturn.type === 'retry') {
          finalReply = `I've prepared a proposal to retry Background Job ${recId} (${pendingActionToReturn.preview.jobName || ''}). Please review the diagnosis and confirm below.`;
        } else if (pendingActionToReturn.type === 'reprocess') {
          finalReply = `I've prepared a proposal to reprocess IDoc ${recId} (${pendingActionToReturn.preview.idocType || ''}). Please review the diagnosis and confirm below.`;
        } else if (pendingActionToReturn.type === 'retrigger') {
          finalReply = `I've prepared a proposal to retrigger Interface ${recId} (${pendingActionToReturn.preview.interfaceName || ''}). Please review the diagnosis and confirm below.`;
        } else if (pendingActionToReturn.type === 'release_po') {
          finalReply = `I've prepared a proposal to release Purchase Order ${recId} in ${pendingActionToReturn.systemKey || 'DEV'}. This is a Level 3 Sensitive action requiring mandatory human review and business reason.`;
        } else if (pendingActionToReturn.type === 'post_fi_doc') {
          finalReply = `I've prepared a proposal to post a Financial Document in Company Code ${pendingActionToReturn.preview?.companyCode || ''} (${pendingActionToReturn.systemKey || 'DEV'}). This is a Level 3 Sensitive action under highest scrutiny requiring mandatory human review and business reason.`;
        } else if (pendingActionToReturn.type === 'change_master_data') {
          finalReply = `I've prepared a proposal to change master data for ${entLabel} ${recId} in ${pendingActionToReturn.systemKey || 'DEV'}. This is a Level 3 Sensitive action requiring mandatory human review and business reason.`;
        } else {
          finalReply = `I've prepared an update proposal for ${entLabel} ${recId}. Please review the proposed changes and confirm below.`;
        }
      } else if (materialCheckResults) {
        const rows = materialCheckResults.results || [];
        const lines = rows.map((r) => {
          let badge = '🟢';
          if (r.status === 'NOT_EXTENDED') badge = '🟡';
          else if (r.status === 'DELETION_FLAG') badge = '🔴';
          else if (r.status === 'BLOCKED') badge = '⛔';
          else if (r.status === 'NOT_FOUND') badge = '⚪';
          else if (r.status === 'UNKNOWN') badge = '⚠️';
          return `${badge} **${r.material}** in Plant **${r.plant}**: \`${r.status}\` — ${r.reason}`;
        });
        finalReply = `**Material Maintenance Check (MARC Table) for Plant ${materialCheckResults.plant}:**\n\n${lines.join('\n')}\n\n*Summary: ${materialCheckResults.summary.total} checked (${materialCheckResults.summary.OK} OK, ${materialCheckResults.summary.NOT_EXTENDED} not extended, ${materialCheckResults.summary.BLOCKED} blocked, ${materialCheckResults.summary.DELETION_FLAG} deletion flag, ${materialCheckResults.summary.NOT_FOUND} not found).*`;
      } else if (combinedRecords.length > 0) {
        const entLabel = activeEntitySchema?.singularLabel || 'record';
        finalReply = `Here's what I found (${combinedRecords.length} ${entLabel}${combinedRecords.length === 1 ? '' : 's'}):`;
      } else {
        finalReply = "Here's what I found: No records matched your criteria.";
      }

      try {
        console.log(`[OpenRouter API Call #2] Model being sent in request body: "${model}"`);
        const followUpResponse = await axios.post(
          OPENROUTER_API_URL,
          {
            model,
            messages: toolMessages
          },
          { headers, timeout: 30000 }
        );

        const content = followUpResponse.data?.choices?.[0]?.message?.content;
        if (content && typeof content === 'string' && content.trim()) {
          if (isPseudoToolCallContent(content)) {
            console.warn('\n[chat.js] Detected pseudo-tool-call literal text in follow-up call #2 content:');
            console.warn(content);
          } else {
            finalReply = content.trim();
          }
        }
      } catch (secondCallErr) {
        logOpenRouterError('Follow-up Tool Response Call', secondCallErr);
      }

      return res.status(200).json({
        reply: finalReply,
        data: combinedRecords.length > 0 ? combinedRecords : null,
        entityKey: activeEntitySchema?.entityKey || null,
        schema: activeEntitySchema || null,
        proposedAction: pendingActionToReturn,
        error: false
      });
    }

    if (isPseudoToolCallContent(assistantMessage.content)) {
      console.warn('\n[chat.js] Detected pseudo-tool-call literal text in model message.content:');
      console.warn(assistantMessage.content);
      return res.status(200).json({
        reply: 'I had trouble understanding that request — could you rephrase it?',
        data: null,
        error: true
      });
    }

    return res.status(200).json({
      reply: assistantMessage.content || 'I could not find an answer to your query.',
      data: null,
      entityKey: activeEntitySchema?.entityKey || null,
      schema: activeEntitySchema || null,
      proposedAction: null,
      error: false
    });
  } catch (error) {
    logOpenRouterError('Top-level OpenRouter Error', error);

    if (error.response?.status === 429) {
      const errorDetail =
        error.response?.data?.error?.metadata?.raw ||
        error.response?.data?.error?.message ||
        'OpenRouter free-tier rate limit reached.';

      return res.status(429).json({
        reply: `⚠️ OpenRouter rate limit: ${errorDetail}`,
        data: null,
        error: true,
        isRateLimit: true,
        realStatusCode: error.response?.status,
        openRouterError: error.response?.data || null
      });
    }

    const errorMsg =
      error.response?.data?.error?.message ||
      error.message ||
      'Failed to communicate with OpenRouter AI service.';

    return res.status(200).json({
      reply: `⚠️ Error contacting AI service: ${errorMsg}`,
      data: null,
      error: true,
      realStatusCode: error.response?.status || null,
      openRouterError: error.response?.data || null
    });
  }
});

export default router;
