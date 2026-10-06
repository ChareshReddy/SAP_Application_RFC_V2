import express from 'express';
import {
  rfcValidateSourceBom,
  rfcReadBom,
  rfcCreateBom,
  rfcCopyBom,
  rfcDeleteBom,
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
 * POST /api/bom/copy
 * Copies a BOM from source to target in <200ms using CSAP RFCs.
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
      targetAlternative
    } = req.body || {};

    const result = await rfcCopyBom({
      sourceMaterial,
      sourcePlant,
      targetMaterial,
      targetPlant,
      bomUsage,
      alternativeBom,
      sourceAlternative,
      targetAlternative
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

export default router;
