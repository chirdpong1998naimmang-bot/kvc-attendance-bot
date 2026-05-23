// ============================================================
// LINE Service - ส่งข้อความ / Flex Message / QR Code
// ============================================================

const line = require('@line/bot-sdk');

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// ส่ง Flex Message พร้อม QR Code เข้ากลุ่ม
async function sendQRToGroup(groupId, { token, qrType, subjectName, room, sentAt }) {
  const isCheckIn = qrType === 'check_in';
  const liffUrl = `${process.env.LIFF_URL}?token=${token}`;

  const flexMessage = {
    type: 'flex',
    altText: `${isCheckIn ? 'เช็คชื่อเข้าเรียน' : 'เช็คชื่อหลังเรียน'} - ${subjectName}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: isCheckIn ? '#0F6E56' : '#185FA5',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: isCheckIn ? '📋 เช็คชื่อเข้าเรียน' : '📋 เช็คชื่อหลังเรียน',
            color: '#FFFFFF',
            size: 'lg',
            weight: 'bold'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: subjectName,
            weight: 'bold',
            size: 'md',
            wrap: true
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              makeInfoRow('ห้องเรียน', room || '-'),
              makeInfoRow('เวลา', sentAt),
              makeInfoRow('Token', token)
            ]
          },
          {
            type: 'text',
            text: `หมดอายุใน ${process.env.QR_EXPIRE_MINUTES || 30} นาที`,
            size: 'xs',
            color: '#999999',
            margin: 'md',
            align: 'center'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: isCheckIn ? '✅ กดเช็คชื่อเข้าเรียน' : '✅ กดเช็คชื่อหลังเรียน',
              uri: liffUrl
            },
            style: 'primary',
            color: isCheckIn ? '#0F6E56' : '#185FA5',
            height: 'md'
          }
        ]
      }
    }
  };

  try {
    await client.pushMessage({
      to: groupId,
      messages: [flexMessage]
    });
    console.log(`✅ QR sent to group ${groupId}: ${token} (${qrType})`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send QR to group ${groupId}:`, err.message);
    return false;
  }
}

// ส่งข้อความธรรมดาไปยังผู้ใช้
async function sendTextMessage(to, text) {
  try {
    await client.pushMessage({
      to,
      messages: [{ type: 'text', text }]
    });
  } catch (err) {
    console.error('Failed to send text:', err.message);
  }
}

// ส่งข้อความยืนยันการเช็คชื่อสำเร็จ
async function sendCheckInConfirmation(userId, { studentName, subjectName, checkType, checkedAt }) {
  const isCheckIn = checkType === 'check_in';
  const flex = {
    type: 'flex',
    altText: `เช็คชื่อสำเร็จ - ${subjectName}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '✅ บันทึกสำเร็จ',
            weight: 'bold',
            size: 'lg',
            color: '#0F6E56'
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              makeInfoRow('ชื่อ', studentName),
              makeInfoRow('วิชา', subjectName),
              makeInfoRow('ประเภท', isCheckIn ? 'เข้าเรียน' : 'หลังเรียน'),
              makeInfoRow('เวลา', checkedAt)
            ]
          }
        ]
      }
    }
  };

  try {
    await client.pushMessage({ to: userId, messages: [flex] });
  } catch (err) {
    console.error('Failed to send confirmation:', err.message);
  }
}

// แจ้งเตือนครูเมื่อมีนักเรียนเช็คชื่อ
async function notifyTeacher(teacherLineId, { studentName, subjectName, checkType, status }) {
  const text = `📌 ${studentName} ${checkType === 'check_in' ? 'เข้าเรียน' : 'ออก'} (${status}) - ${subjectName}`;
  await sendTextMessage(teacherLineId, text);
}

// Helper: สร้าง info row สำหรับ Flex Message
function makeInfoRow(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#888888',
        flex: 3
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        weight: 'bold',
        flex: 5,
        align: 'end'
      }
    ]
  };
}

module.exports = {
  client,
  sendQRToGroup,
  sendTextMessage,
  sendCheckInConfirmation,
  notifyTeacher
};
