const nodemailer = require('nodemailer');

const getTransporter = () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
};

const SLOT_TIMES = {
  1: '8:10 AM – 9:00 AM', 2: '9:00 AM – 9:50 AM', 3: '9:50 AM – 10:40 AM',
  4: '11:00 AM – 11:50 AM', 5: '11:50 AM – 12:40 PM', 6: '1:30 PM – 2:20 PM',
  7: '2:20 PM – 3:10 PM', 8: '3:10 PM – 4:00 PM', 9: '4:00 PM – 4:50 PM'
};

const TYPE_LABELS = {
  adjustment: 'Class Adjustment', duty: 'Duty Assignment',
  extra_class: 'Extra Class', cancellation: 'Class Cancellation'
};

const sendDutyNotification = async (trainer, duty, assignedByName) => {
  const transporter = getTransporter();
  if (!transporter) { console.log('Email not configured, skipping notification'); return; }

  const subject = `${TYPE_LABELS[duty.type] || 'Assignment'} — ${new Date(duty.date).toDateString()} · Slot ${duty.slot_number}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px">
      <div style="background:#1e3a5f;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">CDC Timetable System</h2>
        <p style="margin:5px 0 0;opacity:0.8">MREI — Career Development Centre</p>
      </div>
      <div style="background:white;padding:24px;border-radius:0 0 8px 8px">
        <p>Dear <strong>${trainer.name}</strong>,</p>
        <p>A <strong>${TYPE_LABELS[duty.type] || duty.type}</strong> has been assigned to you:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;width:40%">Date</td><td style="padding:8px">${new Date(duty.date).toDateString()}</td></tr>
          <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Time Slot</td><td style="padding:8px">Slot ${duty.slot_number} (${SLOT_TIMES[duty.slot_number] || ''})</td></tr>
          ${duty.class_name ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Class</td><td style="padding:8px">${duty.class_name}</td></tr>` : ''}
          ${duty.room ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Room</td><td style="padding:8px">${duty.room}</td></tr>` : ''}
          ${duty.topic ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Topic</td><td style="padding:8px">${duty.topic}</td></tr>` : ''}
          ${duty.instructions ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Instructions</td><td style="padding:8px">${duty.instructions}</td></tr>` : ''}
          ${duty.note ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Note</td><td style="padding:8px">${duty.note}</td></tr>` : ''}
          <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">Assigned by</td><td style="padding:8px">${assignedByName}</td></tr>
        </table>
        <p style="color:#666;font-size:13px">Please log in to the CDC Timetable System to acknowledge this assignment.</p>
      </div>
    </div>`;

  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || `CDC System <${process.env.SMTP_USER}>`,
      to: trainer.email,
      subject,
      html
    });
    console.log(`✅ Email sent to ${trainer.email}`);
  } catch (err) {
    console.error(`❌ Email failed to ${trainer.email}:`, err.message);
  }
};

module.exports = { sendDutyNotification };
