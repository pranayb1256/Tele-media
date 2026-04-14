require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { S3Client } = require("@aws-sdk/client-s3");
const multer = require("multer");
const multerS3 = require("multer-s3");
const cors = require("cors");
const crypto = require("crypto");
const PDFDocument = require("pdfkit"); // Add PDF Document generation

// ==========================================
// CPaaS Integrations (SendGrid for Email)
// ==========================================
const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// ==========================================
// SECaaS (Security): Encryption at Rest (Simulating AWS KMS)
// ==========================================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4"; 
const IV_LENGTH = 16;

function encryptHIPAA(text) {
  if (!text) return text;
  let iv = crypto.randomBytes(IV_LENGTH);
  let cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptHIPAA(text) {
  if (!text) return text;
  let textParts = text.split(":");
  let iv = Buffer.from(textParts.shift(), "hex");
  let encryptedText = Buffer.from(textParts.join(":"), "hex");
  let decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// ==========================================
// DBaaS: Fully Managed MongoDB Atlas
// ==========================================
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/telemedia_ehr";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ DBaaS: Connected to MongoDB (EHR Database)"))
  .catch(err => console.error("❌ DBaaS Connection Error:", err));

const ehrSchema = new mongoose.Schema({
  patientName: String,
  doctorId: String,
  diagnosisEncrypted: String,
  scanUrl: String, 
  createdAt: { type: Date, default: Date.now }
});
const EHRRecord = mongoose.model("EHRRecord", ehrSchema);

// ==========================================
// STaaS: AWS S3 unstructured Data Storage (with Fallback)
// ==========================================
let uploadScan;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  });

  uploadScan = multer({
    storage: multerS3({
      s3: s3,
      bucket: process.env.AWS_S3_BUCKET,
      metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname, classification: "CONFIDENTIAL-MEDICAL-IMAGING" });
      },
      key: function (req, file, cb) {
        cb(null, "ehr-scans/" + Date.now().toString() + "-" + file.originalname);
      }
    })
  });
} else {
  console.warn("⚠️ AWS S3 Credentials missing. Falling back to local disk storage for Medical Scans.");
  const fs = require('fs');
  const uploadDir = './uploads';
  if (!fs.existsSync(uploadDir)){
      fs.mkdirSync(uploadDir);
  }
  uploadScan = multer({ dest: 'uploads/' });
}

// ==========================================
// EHR PORTAL API ROUTES
// ==========================================
app.get("/api/ehr", async (req, res) => {
  try {
    const rawRecords = await EHRRecord.find().sort({ createdAt: -1 });
    const records = rawRecords.map(doc => ({
      _id: doc._id,
      patientName: doc.patientName,
      doctorId: doc.doctorId,
      diagnosis: decryptHIPAA(doc.diagnosisEncrypted),
      scanUrl: doc.scanUrl,
      createdAt: doc.createdAt
    }));
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ehr", uploadScan.single("medicalScan"), async (req, res) => {
  try {
    let scanUrl = null;
    if (req.file) {
      scanUrl = req.file.location || `/uploads/${req.file.filename}`;
      console.log(`✅ STaaS/Local: Saved Medical Scan to ${scanUrl}`);
    }

    const newRecord = new EHRRecord({
      patientName: req.body.patientName,
      doctorId: req.body.doctorId || "Dr. Demo",
      diagnosisEncrypted: encryptHIPAA(req.body.diagnosis),
      scanUrl: scanUrl
    });

    await newRecord.save();
    console.log("✅ DBaaS: Saved encrypted Electronic Health Record to MongoDB");

    // CPaaS Feature Simulation: Send Email asynchronously via SendGrid
    if (process.env.SENDGRID_API_KEY) {
      console.log(`✉️ CPaaS: Triggering async Email notification to patient [${req.body.patientName}] via SendGrid...`);
      const msg = {
        to: process.env.TEST_PATIENT_EMAIL || 'patient@example.com', 
        from: process.env.VERIFIED_SENDER_EMAIL || 'your-verified-email@domain.com',
        subject: 'New Medical Records Available',
        text: `Hello ${req.body.patientName}, your doctor ${req.body.doctorId || "Dr. Demo"} has posted new lab results.`
      };
      sgMail.send(msg).then(() => console.log('✅ CPaaS Email sent')).catch(err => console.error('❌ CPaaS Email error:', err.response ? err.response.body : err));
    }

    res.status(201).json({ message: "Record securely created and patient notified via CPaaS!" });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 5: Real-Time Analytics API (PaaS Data Aggregation)
app.get("/api/analytics", async (req, res) => {
  try {
    const totalRecords = await EHRRecord.countDocuments();
    
    // Aggregation pipeline to count records per doctor
    const recordsByDoctor = await EHRRecord.aggregate([
      { $group: { _id: "$doctorId", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    // Aggregation pipeline to count recent activity (last 7 days simulation)
    const recentActivity = await EHRRecord.aggregate([
      { 
        $group: { 
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { "_id": 1 } },
      { $limit: 7 }
    ]);

    res.json({
        totalRecords,
        recordsByDoctor,
        recentActivity,
        storageUsageGB: Math.random() * 50 // Emulated S3 metrics
    });
  } catch (error) {
    res.status(500).json({ error: "Analytics Error: " + error.message });
  }
});

// --- NEW FEATURE: One-Click PDF Generation ---
app.get("/api/ehr/:id/pdf", async (req, res) => {
  try {
    const record = await EHRRecord.findById(req.params.id);
    if (!record) return res.status(404).send("EHR not found");

    // Generate PDF Stream
    const doc = new PDFDocument();
    
    res.setHeader("Content-disposition", 'attachment; filename="EHR_Report_' + record._id + '.pdf"');
    res.setHeader("Content-type", "application/pdf");
    
    doc.pipe(res);
    
    doc.fontSize(20).text('🏥 CloudHealth Enterprise', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text('Official Embedded PDF Medical Report', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12);
    doc.text(`Patient Name: ${record.patientName}`);
    doc.text(`Attending Doctor ID: ${record.doctorId}`);
    doc.text(`Date of Entry: ${new Date(record.createdAt).toDateString()}`);
    
    doc.moveDown();
    doc.text(`Clinical Diagnosis (Decrypted for PDF):`);
    doc.rect(doc.x, doc.y, 400, 100).stroke(); // Box for diagnosis
    doc.moveDown(0.5);
    doc.text(decryptHIPAA(record.diagnosisEncrypted));
    
    if (record.scanUrl) {
      doc.moveDown();
      doc.moveDown();
      doc.moveDown();
      doc.moveDown();
      doc.moveDown();
      doc.text(`Tele-Media Attachment:`);
      doc.fillColor('blue').text(record.scanUrl, { link: record.scanUrl, underline: true });
      doc.fillColor('black'); // reset color
    }
    
    doc.end();
  } catch (error) {
    console.error("PDF Gen Error:", error);
    res.status(500).send("Failed to generate PDF Report");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏥 Enterprise API running on http://localhost:${PORT}`);
});
