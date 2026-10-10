import { Client } from 'open-rfc';
import { getRfcConnectionParams } from '../services/sapRfcClient.js';

const client = new Client(getRfcConnectionParams());

async function findBomReaders() {
  await client.open();
  console.log('Connected to S4A! Probing available BOM reading RFCs...');

  const candidates = [
    'BAPI_MATERIAL_BOM_GROUP_GETDET',
    'BAPI_BUS2001_GETBOM',
    'CS_BOM_EXPL_MAT_V2_HANA',
    'CSAP_MAT_BOM_READ',
    'CSON_BOM_READ',
    'RFC_GET_STRUCTURE_DEFINITION'
  ];

  for (const fn of candidates) {
    try {
      const res = await client.call(fn, {});
      console.log(`✅ ${fn}: SUCCESS or RETURN:`, res.RETURN || Object.keys(res));
    } catch (e) {
      console.log(`❌ ${fn}: ${e.message}`);
    }
  }

  await client.close();
}

findBomReaders();
