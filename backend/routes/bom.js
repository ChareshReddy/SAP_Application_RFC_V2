import express from 'express';
import XLSX from 'xlsx';
import {
  rfcValidateSourceBom,
  rfcReadBom,
  rfcExplodeBomHierarchy,
  rfcCreateBom,
  rfcCopyBom,
  rfcDeleteBom,
  rfcBatchValidateBoms,
  rfcBatchCopyBoms,
  pingRfcServer
} from '../services/sapRfcClient.js';
import { validateSourceBom as validateSourceBomGui } from '../services/sapGuiClient.js';

const router = express.Router();

/**
 * GET /api/bom/ping
 * Checks RFC connectivity to SAP.
 */
router.get('/ping', async (req, res) => {
  try {
    const pingResult = await pingRfcServer();
    return res.status(200).json(pingResult);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/**
 * POST /api/bom/validate-source
 * Validates a source / reference BOM in SAP via fast RFC (CSAP_MAT_BOM_READ)
 * or fallback GUI Scripting.
 */
router.post('/validate-source', async (req, res) => {
  try {
    const { material, plant, bomUsage, alternativeBom } = req.body || {};

    if (!material || !String(material).trim()) {
      return res.status(200).json({
        success: false,
        errorCode: 'MATERIAL_NOT_FOUND',
        message: 'Material is required for source BOM validation.'
      });
    }

    if (!plant || !String(plant).trim()) {
      return res.status(200).json({
        success: false,
        errorCode: 'MATERIAL_PLANT_INVALID',
        message: 'Plant is required for source BOM validation.'
      });
    }

    const isMock = process.env.USE_MOCK_SAP === 'true';
    const useRfc = process.env.SAP_BOM_MODE === 'RFC' || (!isMock && process.env.SAP_BOM_MODE !== 'GUI');
    let result;
    if (useRfc && !isMock) {
      result = await rfcValidateSourceBom({
        material,
        plant,
        bomUsage,
        alternativeBom
      });
    } else {
      result = await validateSourceBomGui({
        material,
        plant,
        bomUsage,
        alternativeBom
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[bom.js] validate-source error:', err.message);
    return res.status(200).json({
      success: false,
      errorCode: 'SAP_VALIDATION_ERROR',
      message: `Source BOM validation failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/read
 * Reads BOM header and items via CSAP_MAT_BOM_READ.
 */
router.post('/read', async (req, res) => {
  try {
    const { material, plant, bomUsage, alternativeBom } = req.body || {};
    const result = await rfcReadBom({
      material,
      plant,
      bomUsage,
      alternativeBom
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `BOM Read failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/create
 * Creates a Material BOM via CSAP_MAT_BOM_CREATE.
 */
router.post('/create', async (req, res) => {
  try {
    const { material, plant, bomUsage, alternativeBom, validFrom, components } = req.body || {};
    const result = await rfcCreateBom({
      material,
      plant,
      bomUsage,
      alternativeBom,
      validFrom,
      components
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `BOM Creation failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/hierarchy
 * Explodes and returns the full multi-level BOM hierarchy.
 */
router.post('/hierarchy', async (req, res) => {
  try {
    const { material, plant, bomUsage, alternativeBom } = req.body || {};
    const result = await rfcExplodeBomHierarchy({
      material,
      plant,
      bomUsage,
      alternativeBom
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `Failed to explode BOM hierarchy: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/copy
 * Copies a BOM from source to target in <200ms using CSAP RFCs, including full hierarchy.
 */
router.post('/copy', async (req, res) => {
  try {
    const {
      sourceMaterial,
      sourcePlant,
      targetMaterial,
      targetPlant,
      bomUsage,
      alternativeBom,
      sourceAlternative,
      targetAlternative,
      copyHierarchy = true
    } = req.body || {};

    const result = await rfcCopyBom({
      sourceMaterial,
      sourcePlant,
      targetMaterial,
      targetPlant,
      bomUsage,
      alternativeBom,
      sourceAlternative,
      targetAlternative,
      copyHierarchy
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `BOM Copy failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/delete
 * Deletes a BOM via CSAP_MAT_BOM_DELETE.
 */
router.post('/delete', async (req, res) => {
  try {
    const { material, plant, bomUsage, alternativeBom } = req.body || {};
    const result = await rfcDeleteBom({
      material,
      plant,
      bomUsage,
      alternativeBom
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `BOM Delete failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/batch-validate
 * Validates an array of BOM copy requests against SAP (checks source existence and target availability).
 */
router.post('/batch-validate', async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const result = await rfcBatchValidateBoms(items);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[bom.js] batch-validate error:', err.message);
    return res.status(500).json({
      success: false,
      message: `Batch validation failed: ${err.message}`
    });
  }
});

/**
 * POST /api/bom/batch-copy
 * Executes batch BOM copy sequentially with row-level error isolation.
 */
router.post('/batch-copy', async (req, res) => {
  try {
    const { items = [], skipErrors = true, copyHierarchy = true } = req.body || {};
    const result = await rfcBatchCopyBoms(items, { skipErrors, copyHierarchy });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[bom.js] batch-copy error:', err.message);
    return res.status(500).json({
      success: false,
      message: `Batch copy failed: ${err.message}`
    });
  }
});

/**
 * GET /api/bom/template
 * Generates and downloads the official Excel template for Bulk BOM Copy.
 */
router.get('/template', (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const sampleData = [
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

    const ws = XLSX.utils.json_to_sheet(sampleData);
    ws['!cols'] = [
      { wch: 18 },
      { wch: 14 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 14 },
      { wch: 18 },
      { wch: 18 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'BOM_Copy_Template');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="BOM_Copy_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `Failed to generate Excel template: ${err.message}`
    });
  }
});

export default router;
