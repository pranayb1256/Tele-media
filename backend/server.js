require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { S3Client } = require("@aws-sdk/client-s3");
const multer = require("multer");
const multerS3 = require("multer-s3");
const cors = require("cors");
const crypto = require("crypto");
const PDFDocument = require("pdfkit"); // Add PDF Document generation

// CPaaS Integrations (SendGrid for Email)
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ DBaaS: Connected to MongoDB Atlas (EHR Database)"))
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
// STaaS: AWS S3 unstructured Data Storage
// ==========================================
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

const uploadScan = multer({
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
      scanUrl = req.file.location;
      console.log("✅ STaaS: securely uploaded Medical Scan to AWS S3 Storage");
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
    console.log(`✉️ CPaaS: Triggering async Email notification to patient [${req.body.patientName}] via SendGrid...`);
    // Example SendGrid usage once integrated:
    const msg = {
      to: 'patient@example.com', // Get from req.body or DB
      from: 'your-verified-email@domain.com', // Must be verified in SendGrid
      subject: 'New Medical Records Available',
      text: `Hello ${req.body.patientName}, your doctor ${req.body.doctorId || "Dr. Demo"} has posted new lab results.`
    };
    sgMail.send(msg).then(() => console.log('Email sent')).catch(err => console.error(err));

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
    
    // Set headers so browser downloads it
    res.setHeader("Content-disposition", 'attachment; filename="EHR_Report_' + record._id + '.pdf"');
    res.setHeader("Content-type", "application/pdf");
    
    // Pipe PDF to response
    doc.pipe(res);
    
    // Add PDF Content
    doc.fontSize(20).text('🏥 CloudHealth Enterprise', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text('Official Embedded PDF Medical Report', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12);
    doc.text(`Patient Name: ${record.patientName}`);
    doc.text(`Attending Doctor ID: ${record.doctorId}`);
    doc.text(`Date of Entry: ${record.createdAt.toDateString()}`);
    
    doc.moveDown();
    doc.rect(doc.x, doc.y, 400, 100).stroke(); // Box for diagnosis
    doc.moveDown(0.5);
    doc.text(`Clinical Diagnosis (Decrypted for PDF):`);
    doc.text(decryptData(record.encryptedDiagnosis, record.encryptionIV));
    
    if (record.s3ScanUrl) {
      doc.moveDown();
      doc.text(`AWS S3 Tele-Media Attachment:`);
      doc.fillColor('blue').text(record.s3ScanUrl, { link: record.s3ScanUrl, underline: true });
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
