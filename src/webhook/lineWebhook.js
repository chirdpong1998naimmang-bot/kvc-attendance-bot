// ============================================================
// LINE Webhook Handler
// รับ event จาก LINE Platform (ข้อความ, เข้ากลุ่ม, เพิ่มเพื่อน)
// ============================================================

const express = require('express');
const line = require('@line/bot-sdk');
const { pool } = require('../config/database');
const { sendTextMessage } = require('../services/lineService');

const router = express.Router();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// ============================================================
// Webhook Endpoint
// ============================================================

router.post('/line',
  // ใช้ raw body สำหรับ LINE signature verification
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // ตอบ 200 ทันที (LINE timeout 1 วินาที)
    res.sendStatus(200);

    try {
      // Verify signature
      const signature = req.headers['x-line-signature'];
      if (!line.validateSignature(req.body, lineConfig.channelSecret, signature)) {
        console.error('Invalid signature');
        return;
      }

      const body = JSON.parse(req.body.toString());
      const events = body.events || [];

      for (const event of events) {
        await handleEvent(event);
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
  }
);

// ============================================================
// Event Handler
// ============================================================

async function handleEvent(event) {
  const { type, source } = event;

  switch (type) {
    case 'join':
      // Bot ถูกเชิญเข้ากลุ่ม → บันทึก Group ID
      await handleJoinGroup(event);
      break;

    case 'leave':
      // Bot ถูกเอาออกจากกลุ่ม
      await handleLeaveGroup(event);
      break;

    case 'follow':
      // มีคนเพิ่ม Bot เป็นเพื่อน
      await handleFollow(event);
      break;

    case 'message':
      if (source.type === 'user') {
        await handleDirectMessage(event);
      }
      break;

    default:
      break;
  }
}

// ============================================================
// Handler: Bot เข้ากลุ่ม
// ============================================================
async function handleJoinGroup(event) {
  const groupId = event.source.groupId;
  console.log(`📥 Bot joined group: ${groupId}`);

  // ดึงข้อมูลกลุ่ม
  let groupName = 'Unknown';
  let memberCount = 0;
  try {
    const { MessagingApiClient } = require('@line/bot-sdk').messagingApi;
    const client = new MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
    });
    const summary = await client.getGroupSummary(groupId);
    groupName = summary.groupName || 'Unknown';
    const countResult = await client.getGroupMemberCount(groupId);
    memberCount = countResult || 0;
  } catch (err) {
    console.warn('Could not get group info:', err.message);
  }

  // บันทึกลง Database
  await pool.query(
    `INSERT INTO line_groups (line_group_id, group_name, member_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (line_group_id) 
     DO UPDATE SET group_name = $2, member_count = $3, is_active = TRUE, updated_at = NOW()`,
    [groupId, groupName, memberCount]
  );

  // ส่งข้อความต้อนรับ
  await sendTextMessage(groupId,
    `สวัสดีครับ! 🙏\n` +
    `ผมคือ Bot เช็คชื่อ วอศ.กาญจนบุรี\n\n` +
    `ผมจะส่ง QR Code สำหรับเช็คชื่อเข้าเรียนและหลังเรียนให้อัตโนมัติตามตารางสอนครับ\n\n` +
    `กลุ่มนี้: ${groupName}\n` +
    `Group ID: ${groupId}`
  );

  // Log
  await pool.query(
    `INSERT INTO system_logs (event_type, event_data)
     VALUES ('bot_join_group', $1)`,
    [JSON.stringify({ group_id: groupId, group_name: groupName })]
  );
}

// ============================================================
// Handler: Bot ถูกเอาออกจากกลุ่ม
// ============================================================
async function handleLeaveGroup(event) {
  const groupId = event.source.groupId;
  console.log(`📤 Bot left group: ${groupId}`);

  await pool.query(
    `UPDATE line_groups SET is_active = FALSE, updated_at = NOW() 
     WHERE line_group_id = $1`,
    [groupId]
  );
}

// ============================================================
// Handler: มีคนเพิ่มเพื่อน Bot
// ============================================================
async function handleFollow(event) {
  const userId = event.source.userId;
  console.log(`👤 New follower: ${userId}`);

  await sendTextMessage(userId,
    `สวัสดีครับ! 🙏\n` +
    `ผมคือ Bot เช็คชื่อ วิทยาลัยอาชีวศึกษากาญจนบุรี\n\n` +
    `📋 วิธีใช้งาน:\n` +
    `1. เข้ากลุ่มไลน์ของรายวิชา\n` +
    `2. เมื่อถึงเวลา Bot จะส่ง QR Code\n` +
    `3. กดปุ่ม "เช็คชื่อ" ในข้อความ\n` +
    `4. ถ่ายรูปยืนยันตัวตน + ตรวจพิกัด\n` +
    `5. กดบันทึก เป็นอันเสร็จ!\n\n` +
    `หากมีปัญหา ติดต่ออาจารย์ผู้สอนครับ`
  );

  // ตรวจสอบว่าเป็นนักเรียนในระบบหรือไม่ ถ้าใช่ อัปเดต line_user_id
  // (นักเรียนต้องลงทะเบียนผ่าน LIFF App ก่อนถึงจะผูก line_user_id ได้)
}

// ============================================================
// Handler: ข้อความตรงจากผู้ใช้ (DM)
// ============================================================
async function handleDirectMessage(event) {
  const userId = event.source.userId;
  const text = event.message?.text?.trim();

  if (!text) return;

  const lowerText = text.toLowerCase();

  // คำสั่งพื้นฐาน
  if (lowerText === 'สถานะ' || lowerText === 'status') {
    await handleStatusCommand(userId);
  } else if (lowerText === 'ช่วยเหลือ' || lowerText === 'help') {
    await handleHelpCommand(userId);
  } else if (lowerText.startsWith('เช็ค ') || lowerText.startsWith('check ')) {
    // เช็คชื่อด้วย token (สำหรับกรณี QR Scanner ใช้ไม่ได้)
    const token = text.split(' ')[1];
    if (token) {
      await sendTextMessage(userId,
        `กรุณาเช็คชื่อผ่าน LIFF App โดยกดลิงก์นี้:\n${process.env.LIFF_URL}?token=${token.toUpperCase()}`
      );
    }
  } else {
    await sendTextMessage(userId,
      `พิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่งที่ใช้ได้ครับ`
    );
  }
}

// คำสั่ง: ดูสถานะการเช็คชื่อวันนี้
async function handleStatusCommand(userId) {
  // ตรวจสอบว่าเป็นนักเรียนหรือครู
  const studentResult = await pool.query(
    'SELECT id, name, student_code, group_name FROM students WHERE line_user_id = $1',
    [userId]
  );

  if (studentResult.rows.length > 0) {
    const student = studentResult.rows[0];
    const today = new Date().toISOString().slice(0, 10);

    const records = await pool.query(
      `SELECT ar.check_type, ar.status, ar.checked_at, s.subject_name
       FROM attendance_records ar
       JOIN qr_sessions qs ON ar.qr_session_id = qs.id
       JOIN subjects s ON qs.subject_id = s.id
       WHERE ar.student_id = $1 AND DATE(ar.checked_at) = $2
       ORDER BY ar.checked_at`,
      [student.id, today]
    );

    if (records.rows.length === 0) {
      await sendTextMessage(userId, `📋 ${student.name}\nวันนี้ยังไม่มีการเช็คชื่อครับ`);
    } else {
      let msg = `📋 ${student.name} (${student.student_code})\nสถานะวันนี้:\n\n`;
      records.rows.forEach(r => {
        const time = new Date(r.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        const type = r.check_type === 'check_in' ? '🟢 เข้า' : '🔵 ออก';
        msg += `${type} ${r.subject_name} (${r.status}) ${time}\n`;
      });
      await sendTextMessage(userId, msg);
    }
  } else {
    // อาจเป็นครู
    const teacherResult = await pool.query(
      'SELECT id, name FROM teachers WHERE line_user_id = $1',
      [userId]
    );
    if (teacherResult.rows.length > 0) {
      await sendTextMessage(userId,
        `สวัสดีครับอาจารย์ ${teacherResult.rows[0].name}\nกรุณาใช้ Dashboard เพื่อดูสถานะการเช็คชื่อครับ`
      );
    } else {
      await sendTextMessage(userId,
        `ไม่พบข้อมูลของคุณในระบบ กรุณาลงทะเบียนผ่าน LIFF App ก่อนครับ`
      );
    }
  }
}

// คำสั่ง: ช่วยเหลือ
async function handleHelpCommand(userId) {
  await sendTextMessage(userId,
    `📚 คำสั่งที่ใช้ได้:\n\n` +
    `• "สถานะ" - ดูสถานะเช็คชื่อวันนี้\n` +
    `• "เช็ค XXXX" - เช็คชื่อด้วย token\n` +
    `• "ช่วยเหลือ" - แสดงข้อความนี้\n\n` +
    `💡 วิธีเช็คชื่อปกติ:\n` +
    `กดปุ่ม "เช็คชื่อ" ในข้อความ QR Code ที่ Bot ส่งในกลุ่มไลน์`
  );
}

module.exports = { lineWebhookRouter: router };
