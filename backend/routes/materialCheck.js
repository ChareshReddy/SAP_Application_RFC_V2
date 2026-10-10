import express from 'express';
import { checkMaterialMaintenance } from '../services/materialCheck.js';
import { rfcReadBom } from '../services/sapRfcClient.js';
import { verifyBomInCs03, getMockBomDataset } from '../services/sapGuiClient.js';

const router = express.Router();

/**
 * POST /api/materials/check (also mounts at root POST /)
 * Checks whether materials are extended and maintained in a specific plant via MARC/MARA.
 *
 * Request Body:
 * {
 *   materials?: string[],
 *   material?: string,
 *   bomMaterial?: string,
 *   plant: string,
 *   bomUsage?: string
 * }
 */
async function handleMaterialCheck(req, res) {
  try {
    const { materials, material, bomMaterial, plant, bomUsage = '1' } = req.body || {};

    if (!plant) {
      return res.status(400).json({
        success: false,
        error: 'Plant is required.',
        message: 'A target SAP plant code (e.g. 1000, 1001, 1012) is required.'
      });
    }

    let targetMaterials = [];

    if (Array.isArray(materials) && materials.length > 0) {
      targetMaterials = materials;
    } else if (material && typeof material === 'string') {
      targetMaterials = [material];
    } else if (bomMaterial && typeof bomMaterial === 'string') {
      // Expand BOM components to check via fast RFC
      try {
        const useRfc = process.env.SAP_BOM_MODE !== 'GUI';
        const bomRes = useRfc
          ? await rfcReadBom({
              material: bomMaterial,
              plant: String(plant).trim(),
              bomUsage: String(bomUsage).trim()
            })
          : await verifyBomInCs03({
              material: bomMaterial,
              plant: String(plant).trim(),
              bomUsage: String(bomUsage).trim()
            });
        const comps = bomRes.components || [];
        targetMaterials = [
          bomMaterial,
          ...comps.map((c) => c.material || c.component).filter(Boolean)
        ];
      } catch (bomErr) {
        console.warn('[materialCheckRoute] Could not expand BOM components:', bomErr.message);
        targetMaterials = [bomMaterial];
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Materials required.',
        message: 'Must provide either `materials` (array), `material` (string), or `bomMaterial` (string).'
      });
    }

    const checkResult = await checkMaterialMaintenance(targetMaterials, plant);
    return res.status(200).json(checkResult);
  } catch (err) {
    console.error('[materialCheckRoute] Error:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error during material maintenance check.'
    });
  }
}

router.post('/', handleMaterialCheck);
router.post('/check', handleMaterialCheck);

export default router;
