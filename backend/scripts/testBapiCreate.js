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
  console.log('Connected to S4A! Testing BAPI_MATERIAL_BOM_GROUP_CREATE for Target: A1BH0214C / 1001 / Alt 07...');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // 20261005
  const bgrId = 'BGR_01';

  // Sample items from source BOM
  const sourceComponents = [
    { item: '0010', category: 'L', component: 'B1BH0214C', qty: '100.000', unit: 'PAA' },
    { item: '0020', category: 'L', component: 'C1BH0214C', qty: '100.000', unit: 'PAA' },
    { item: '0030', category: 'L', component: '000000000011021735', qty: '0.017', unit: 'KG' },
    { item: '0050', category: 'L', component: '000000000011021733', qty: '0.015', unit: 'KG' },
    { item: '0070', category: 'L', component: '000000000011021737', qty: '0.002', unit: 'KG' },
    { item: '0080', category: 'L', component: '000000000011021734', qty: '0.002', unit: 'KG' },
    { item: '0090', category: 'L', component: '000000000011021732', qty: '0.003', unit: 'KG' },
    { item: '0100', category: 'L', component: '000000000011022139', qty: '0.001', unit: 'KG' },
    { item: '0110', category: 'L', component: '000000000011021686', qty: '0.125', unit: 'KG' },
    { item: '0120', category: 'L', component: '000000000011022154', qty: '0.100', unit: 'L' },
    { item: '0130', category: 'L', component: '000000000012000079', qty: '0.220', unit: 'KG' },
    { item: '0140', category: 'L', component: 'PPBH0001C', qty: '100.000', unit: 'EA' },
    { item: '0150', category: 'L', component: '000000000011021698', qty: '0.090', unit: 'L' },
    { item: '0160', category: 'L', component: 'C1HL0003C', qty: '100.000', unit: 'PAA' },
    { item: '0170', category: 'L', component: '000000000011031877', qty: '0.018', unit: 'KG' },
    { item: '0180', category: 'L', component: '000000000011031874', qty: '0.017', unit: 'KG' }
  ];

  const bomGroup = [{
    BOM_GROUP_IDENTIFICATION: bgrId,
    BOM_USAGE: '1',
    CREATED_IN_PLANT: '1001'
  }];

  const variants = [{
    BOM_GROUP_IDENTIFICATION: bgrId,
    OBJECT_ID: 'VAR_01',
    FUNCTION: 'NEW',
    ALTERNATIVE_BOM: '07',
    BOM_STATUS: '01',
    BASE_QTY: '100',
    BASE_UNIT: 'PAA',
    VALID_FROM_DATE: today
  }];

  const items = sourceComponents.map((c, idx) => ({
    BOM_GROUP_IDENTIFICATION: bgrId,
    ITEM_ID: `ITM_${String(idx + 1).padStart(3, '0')}`,
    OBJECT_ID: `ITM_${String(idx + 1).padStart(3, '0')}`,
    ITEM_NO: c.item,
    ITEM_CAT: c.category,
    COMPONENT: c.component,
    COMP_QTY: c.qty,
    COMP_UNIT: c.unit,
    VALID_FROM_DATE: today
  }));

  const itemAssignments = items.map(itm => ({
    BOM_GROUP_IDENTIFICATION: bgrId,
    FUNCTION: 'NEW',
    SUPER_OBJECT_TYPE: 'BOM',
    SUPER_OBJECT_ID: 'VAR_01',
    SUB_OBJECT_TYPE: 'ITM',
    SUB_OBJECT_ID: itm.ITEM_ID,
    VALID_FROM_DATE: today
  }));

  const materialRelations = [{
    BOM_GROUP_IDENTIFICATION: bgrId,
    MATERIAL: 'A1BH0214C',
    PLANT: '1001',
    BOM_USAGE: '1',
    ALTERNATIVE_BOM: '07'
  }];

  try {
    console.log('Sending live BAPI_MATERIAL_BOM_GROUP_CREATE...');
    const res = await client.call('BAPI_MATERIAL_BOM_GROUP_CREATE', {
      ALL_ERROR: 'X',
      BOMGROUP: bomGroup,
      VARIANTS: variants,
      ITEMS: items,
      ITEMASSIGNMENTS: itemAssignments,
      MATERIALRELATIONS: materialRelations,
      SUBITEMS: [],
      SUBITEMASSIGNMENTS: [],
      TEXTS: [],
      RETURN: []
    });

    console.log('--- BAPI RETURN MESSAGES ---');
    console.log(JSON.stringify(res.RETURN, null, 2));

    const errors = (res.RETURN || []).filter(r => r.TYPE === 'E' || r.TYPE === 'A');
    if (errors.length > 0) {
      console.error('BOM creation had errors. Not committing.');
    } else {
      console.log('BOM created successfully! Calling BAPI_TRANSACTION_COMMIT...');
      const commitRes = await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });
      console.log('Commit result:', commitRes);

      // Verify the new BOM in MAST
      console.log('Verifying target BOM in MAST...');
      const verifyRes = await client.call('RFC_READ_TABLE', {
        QUERY_TABLE: 'MAST',
        DELIMITER: '|',
        OPTIONS: [{ TEXT: "MATNR = 'A1BH0214C' AND WERKS = '1001'" }],
        FIELDS: [{ FIELDNAME: 'MATNR' }, { FIELDNAME: 'WERKS' }, { FIELDNAME: 'STLAN' }, { FIELDNAME: 'STLNR' }, { FIELDNAME: 'STLAL' }],
        DATA: []
      });
      console.log('Target MAST entries:');
      console.log(verifyRes.DATA);
    }
  } catch (e) {
    console.error('BAPI Error:', e.message);
  }

  await client.close();
}

run();
