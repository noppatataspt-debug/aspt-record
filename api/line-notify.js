// ============================================================
// Vercel Serverless Function: LINE Production Notification
// v2.1 - แก้ไขปัญหาตัวเลขใหญ่โดนตัด (shrink-to-fit + ลดขนาด font)
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!LINE_TOKEN || !LINE_GROUP_ID) {
      console.error('Missing env vars:', {
        hasToken: !!LINE_TOKEN,
        hasGroupId: !!LINE_GROUP_ID
      });
      return res.status(500).json({ error: 'Missing LINE credentials' });
    }

    const payload = req.body;
    const record = payload?.record;

    if (!record || !record.submission_id) {
      console.error('Invalid payload:', JSON.stringify(payload));
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const submissionId = record.submission_id;
    console.log('Processing submission:', submissionId);

    const allRecords = await fetchSubmissionRecords(
      SUPABASE_URL,
      SUPABASE_KEY,
      submissionId
    );

    console.log(`Found ${allRecords?.length || 0} records for ${submissionId}`);

    if (!allRecords || allRecords.length === 0) {
      return res.status(200).json({ message: 'No records found' });
    }

    const firstRecord = allRecords.reduce((earliest, r) =>
      new Date(r.created_at) < new Date(earliest.created_at) ? r : earliest
    );

    if (record.id !== firstRecord.id) {
      console.log(`Skipped: record ${record.id} is not first (first is ${firstRecord.id})`);
      return res.status(200).json({
        message: 'Skipped (not first record of submission)'
      });
    }

    const summary = buildSummary(allRecords);
    console.log('Summary:', JSON.stringify(summary));

    const flexMessage = buildFlexMessage(summary);
    console.log('Flex message built, sending to LINE...');

    await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, flexMessage);

    console.log('LINE message sent successfully!');

    return res.status(200).json({
      success: true,
      submission_id: submissionId,
      records_count: allRecords.length
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: error.message });
  }
}

async function fetchSubmissionRecords(supabaseUrl, supabaseKey, submissionId) {
  const url = `${supabaseUrl}/rest/v1/production_records?submission_id=eq.${encodeURIComponent(submissionId)}&select=*`;

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase fetch failed: ${response.status} - ${text}`);
  }

  return await response.json();
}

function buildSummary(records) {
  const first = records[0];

  let goodTotal = 0;
  let dfTotal = 0;
  const dfDetails = [];
  const products = new Set();

  records.forEach((r) => {
    const qty = Number(r.qty) || 0;
    const keyType = String(r.key_type || '').toUpperCase().trim();

    if (keyType === 'OUTPUT' || keyType === 'GOOD' || keyType === 'OK' || keyType === 'FG') {
      goodTotal += qty;
    } else if (keyType === 'DF' || keyType === 'NG' || keyType === 'DEFECT') {
      dfTotal += qty;
      if (qty > 0) {
        dfDetails.push({
          name: String(r.type_name || 'ไม่ระบุ'),
          qty: qty
        });
      }
    }

    if (r.product_name) products.add(r.product_name);
  });

  const total = goodTotal + dfTotal;
  const dfPercent = total > 0 ? ((dfTotal / total) * 100).toFixed(2) : '0.00';

  return {
    date: first.record_date || '',
    shift: first.shift || '-',
    dept: first.dept_name || '-',
    machine: first.machine_name || '-',
    staff: first.staff_name || '-',
    products: Array.from(products).join(', ') || '-',
    goodTotal,
    dfTotal,
    total,
    dfPercent,
    dfDetails
  };
}

function buildFlexMessage(s) {
  const dateParts = String(s.date).split('-');
  const dateFormatted = dateParts.length === 3
    ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`
    : String(s.date);

  const dfRows = [];
  const dfToShow = s.dfDetails.slice(0, 5);

  dfToShow.forEach((d) => {
    dfRows.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: String(d.name),
          size: 'sm',
          color: '#555555',
          flex: 5,
          wrap: true
        },
        {
          type: 'text',
          text: String(d.qty.toLocaleString()),
          size: 'sm',
          color: '#111111',
          align: 'end',
          weight: 'bold',
          flex: 2
        }
      ]
    });
  });

  if (s.dfDetails.length > 5) {
    dfRows.push({
      type: 'text',
      text: `และอีก ${s.dfDetails.length - 5} รายการ`,
      size: 'xs',
      color: '#888888',
      align: 'center'
    });
  }

  if (s.dfDetails.length === 0) {
    dfRows.push({
      type: 'text',
      text: 'ไม่มี DF',
      size: 'sm',
      color: '#047857',
      align: 'center'
    });
  }

  const dfNum = parseFloat(s.dfPercent);
  let headerColor = '#0F6E56';
  let dfBgColor = '#FAEEDA';
  let dfTextColor = '#412402';

  if (dfNum >= 5) {
    headerColor = '#B91C1C';
    dfBgColor = '#FEE2E2';
    dfTextColor = '#7F1D1D';
  } else if (dfNum >= 2) {
    headerColor = '#C2410C';
    dfBgColor = '#FFEDD5';
    dfTextColor = '#7C2D12';
  }

  return {
    type: 'flex',
    altText: `บันทึกการผลิต ${s.dept} กะ${s.shift} %DF ${s.dfPercent}%`,
    contents: {
      type: 'bubble',
      size: 'mega',  // เปลี่ยนจาก kilo เป็น mega ให้กว้างขึ้น
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: 'PRODUCTION LOG',
            color: '#FFFFFF',
            size: 'xs',
            weight: 'bold'
          },
          {
            type: 'text',
            text: 'บันทึกข้อมูลสำเร็จ',
            color: '#FFFFFF',
            size: 'md',
            weight: 'bold',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: 'แผนก / เครื่อง', size: 'xs', color: '#888888' },
              {
                type: 'text',
                text: `${s.dept} • ${s.machine}`,
                size: 'sm',
                weight: 'bold',
                wrap: true,
                margin: 'xs'
              }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  { type: 'text', text: 'วันที่', size: 'xs', color: '#888888' },
                  { type: 'text', text: dateFormatted, size: 'xs', margin: 'xs' }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  { type: 'text', text: 'กะ', size: 'xs', color: '#888888' },
                  { type: 'text', text: String(s.shift), size: 'xs', margin: 'xs' }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 2,
                contents: [
                  { type: 'text', text: 'พนักงาน', size: 'xs', color: '#888888' },
                  { type: 'text', text: String(s.staff), size: 'xs', margin: 'xs', wrap: true }
                ]
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: 'สินค้า', size: 'xs', color: '#888888' },
              { type: 'text', text: String(s.products), size: 'xs', margin: 'xs', wrap: true }
            ]
          },
          { type: 'separator', margin: 'sm' },
          {
            type: 'text',
            text: 'สรุปการผลิต',
            size: 'xs',
            color: '#555555',
            weight: 'bold'
          },
          // กล่อง 3 ช่อง: ของดี / DF / รวม - ใช้ vertical layout แทน horizontal เพื่อให้ตัวเลขใหญ่ๆ ไม่โดนตัด
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#EAF3DE',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  { type: 'text', text: 'ของดี', size: 'xxs', color: '#3B6D11' },
                  {
                    type: 'text',
                    text: s.goodTotal.toLocaleString(),
                    size: 'md',
                    weight: 'bold',
                    color: '#173404',
                    margin: 'xs',
                    adjustMode: 'shrink-to-fit'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#FCEBEB',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  { type: 'text', text: 'DF', size: 'xxs', color: '#A32D2D' },
                  {
                    type: 'text',
                    text: s.dfTotal.toLocaleString(),
                    size: 'md',
                    weight: 'bold',
                    color: '#501313',
                    margin: 'xs',
                    adjustMode: 'shrink-to-fit'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#F1EFE8',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  { type: 'text', text: 'รวม', size: 'xxs', color: '#5F5E5A' },
                  {
                    type: 'text',
                    text: s.total.toLocaleString(),
                    size: 'md',
                    weight: 'bold',
                    color: '#2C2C2A',
                    margin: 'xs',
                    adjustMode: 'shrink-to-fit'
                  }
                ]
              }
            ]
          },
          { type: 'separator', margin: 'sm' },
          {
            type: 'text',
            text: 'รายละเอียด DF',
            size: 'xs',
            color: '#555555',
            weight: 'bold'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: dfRows
          },
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: dfBgColor,
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '%DF',
                size: 'sm',
                weight: 'bold',
                color: dfTextColor,
                gravity: 'center'
              },
              {
                type: 'text',
                text: `${s.dfPercent}%`,
                size: 'xl',
                weight: 'bold',
                color: dfTextColor,
                align: 'end',
                gravity: 'center',
                adjustMode: 'shrink-to-fit'
              }
            ]
          }
        ]
      }
    }
  };
}

async function sendLineMessage(token, groupId, message) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to: groupId,
      messages: [message]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LINE API response:', errorText);
    throw new Error(`LINE API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}
