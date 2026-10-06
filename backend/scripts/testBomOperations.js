import { Client } from 'open-rfc';

const client = new Client({
  saprouter: '/H/103.206.249.51/H/',
  ashost: '192.168.12.241',
  sysnr: '09',
  gwserv: '3309',
  client: '500',
  user: 'LEELAM_EXT',
  passwd: 'TReddy@LR@84!!',
  lang: 'EN'
});

async function run() {
  await client.open();
  console.log('Connected to S4A!');

  // 1. Check MAST table for A1BH0214C in Plant 1012
  try {
    // Full BOM reader for Source BOM
    const mat = 'A1BH0214C';
    const plant = '1012';
    const usage = '1';
    const alt = '01';

    console.log(`Reading BOM for Material: ${mat}, Plant: ${plant}, Usage: ${usage}, Alt: ${alt}...`);
    
    // Step 1: Query MAST
    const mastRes = await client.call('RFC_READ_TABLE', {
      QUERY_TABLE: 'MAST',
      DELIMITER: '|',
      OPTIONS: [{ TEXT: `MATNR = '${mat}' AND WERKS = '${plant}' AND STLAN = '${usage}'` }],
      FIELDS: [{ FIELDNAME: 'MATNR' }, { FIELDNAME: 'WERKS' }, { FIELDNAME: 'STLAN' }, { FIELDNAME: 'STLNR' }, { FIELDNAME: 'STLAL' }],
      DATA: []
    });

    const mastRows = (mastRes.DATA || []).map(r => {
      const parts = r.WA.split('|');
      return {
        matnr: parts[0]?.trim(),
        werks: parts[1]?.trim(),
        stlan: parts[2]?.trim(),
        stlnr: parts[3]?.trim(),
        stlal: parts[4]?.trim()
      };
    });

    console.log('MAST rows found:', mastRows.length);
    const targetMast = mastRows.find(r => r.stlal === alt || parseInt(r.stlal, 10) === parseInt(alt, 10));
    if (!targetMast) {
      console.log(`Alternative ${alt} not found in MAST.`);
      await client.close();
      return;
    }

    const stlnr = targetMast.stlnr;
    const stlal = targetMast.stlal;
    console.log(`Found BOM STLNR: ${stlnr}, STLAL: ${stlal}`);

    // Step 2: Query STAS for items assigned to this alternative
    const stasRes = await client.call('RFC_READ_TABLE', {
      QUERY_TABLE: 'STAS',
      DELIMITER: '|',
      OPTIONS: [{ TEXT: `STLNR = '${stlnr}' AND STLAL = '${stlal}'` }],
      FIELDS: [{ FIELDNAME: 'STLKN' }, { FIELDNAME: 'STPOZ' }],
      DATA: []
    });

    const activeItemNodes = new Set((stasRes.DATA || []).map(r => r.WA.split('|')[0]?.trim()));
    console.log(`Active item nodes (STLKN) for Alt ${stlal}:`, activeItemNodes.size);

    // Step 3: Query STPO for components
    const stpoRes = await client.call('RFC_READ_TABLE', {
      QUERY_TABLE: 'STPO',
      DELIMITER: '|',
      OPTIONS: [{ TEXT: `STLNR = '${stlnr}'` }],
      FIELDS: [
        { FIELDNAME: 'STLKN' },
        { FIELDNAME: 'POSNR' },
        { FIELDNAME: 'POSTP' },
        { FIELDNAME: 'IDNRK' },
        { FIELDNAME: 'MENGE' },
        { FIELDNAME: 'MEINS' },
        { FIELDNAME: 'POTX1' }
      ],
      DATA: []
    });

    const fieldNames = stpoRes.FIELDS.map(f => f.FIELDNAME);
    console.log('STPO Fields returned:', fieldNames);

    const components = [];
    for (const row of (stpoRes.DATA || [])) {
      const p = row.WA.split('|').map(s => s?.trim());
      const rowObj = {};
      fieldNames.forEach((fname, idx) => {
        rowObj[fname] = p[idx] || '';
      });

      if (activeItemNodes.size > 0 && !activeItemNodes.has(rowObj.STLKN)) {
        continue;
      }

      components.push({
        item: rowObj.POSNR,
        itemCategory: rowObj.POSTP || 'L',
        component: rowObj.IDNRK,
        quantity: parseFloat(rowObj.MENGE) || 1,
        unit: rowObj.MEINS || 'EA',
        description: rowObj.POTX1 || ''
      });
    }

    console.log(`--- RETRIEVED ${components.length} REAL COMPONENTS VIA RFC ---`);
    console.log(JSON.stringify(components, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }

  await client.close();
}

run();
