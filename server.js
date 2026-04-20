import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

function cleanText(text) {
  return text
    .replace(/\r/g, " ")
    .replace(/[•●■►]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function uniqueArray(arr = []) {
  return [...new Set(arr.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeSkill(skill) {
  const s = String(skill).toLowerCase().trim();

  const map = {
    "node": "Node.js",
    "nodejs": "Node.js",
    "node.js": "Node.js",
    "express": "Express.js",
    "expressjs": "Express.js",
    "express.js": "Express.js",
    "react": "React.js",
    "reactjs": "React.js",
    "react.js": "React.js",
    "vue": "Vue.js",
    "vuejs": "Vue.js",
    "vue.js": "Vue.js",
    "js": "JavaScript",
    "mongo": "MongoDB",
    "mongodb": "MongoDB",
    "ml": "Machine Learning",
    "ai/ml": "AI/ML",
    "artificial intelligence": "AI/ML",
    "c sharp": "C#",
    "asp.net": "ASP.NET MVC",
    "dotnet": ".NET"
  };

  return map[s] || skill.trim();
}

function normalizeArray(arr = []) {
  return [...new Set(arr.map(normalizeSkill).filter(Boolean))];
}

function extractJobKeywords(jobDescription) {
  const knownKeywords = [
    "JavaScript",
    "Node.js",
    "Express.js",
    "Koa.js",
    "MongoDB",
    "React.js",
    "Angular",
    "Vue.js",
    "Java",
    "J2EE",
    "Spring Boot",
    "MySQL",
    "MariaDB",
    "Git",
    "Jenkins",
    "C#",
    ".NET",
    "ASP.NET MVC",
    "LINQ",
    "SQL Server",
    "Machine Learning",
    "AI/ML",
    "Flutter",
    "React Native",
    "Android",
    "iOS",
    "Problem-solving",
    "Communication",
    "Teamwork",
    "Analytical ability",
    "Logical thinking",
    "SQL",
    "Python",
    "Swagger"
  ];

  const jdLower = jobDescription.toLowerCase();

  return knownKeywords.filter(keyword =>
    jdLower.includes(keyword.toLowerCase())
  );
}

function compareKeywords(resumeSkills, jobKeywords) {
  const normalizedResume = normalizeArray(resumeSkills);
  const normalizedJob = normalizeArray(jobKeywords);

  const matched = normalizedJob.filter(jobSkill =>
    normalizedResume.some(
      resumeSkill => resumeSkill.toLowerCase() === jobSkill.toLowerCase()
    )
  );

  const missing = normalizedJob.filter(jobSkill =>
    !matched.some(match => match.toLowerCase() === jobSkill.toLowerCase())
  );

  return {
    matched: uniqueArray(matched),
    missing: uniqueArray(missing),
  };
}

function calculateATSScore({
  matchedKeywords = [],
  missingKeywords = [],
  technicalSkills = [],
  toolsAndPlatforms = [],
  softSkills = [],
  resumeText = ""
}) {
  const matched = matchedKeywords.length;
  const missing = missingKeywords.length;
  const totalKeywords = matched + missing;

  const keywordScore = totalKeywords > 0
    ? (matched / totalKeywords) * 40
    : 0;

  const relevantSkillsCount =
    technicalSkills.length +
    toolsAndPlatforms.length +
    Math.min(softSkills.length, 5);

  const skillScore = Math.min(20, relevantSkillsCount * 1.5);

  let sectionScore = 0;
  if (/education/i.test(resumeText)) sectionScore += 5;
  if (/experience|internship|work experience/i.test(resumeText)) sectionScore += 5;
  if (/project|projects/i.test(resumeText)) sectionScore += 5;

  let relevanceScore = 0;
  if (/internship|experience/i.test(resumeText)) relevanceScore += 5;
  if (/project|projects/i.test(resumeText)) relevanceScore += 5;
  if (/javascript|node\.js|express\.js|react|java|python|machine learning|mongodb|sql/i.test(resumeText)) {
    relevanceScore += 5;
  }

  let qualityScore = 0;
  if (resumeText.length > 1000) qualityScore += 3;
  if (/\b\d+%|\b\d+\b/.test(resumeText)) qualityScore += 3;
  if (/communication|problem-solving|team/i.test(resumeText)) qualityScore += 4;

  const finalScore = Math.round(
    keywordScore + skillScore + sectionScore + relevanceScore + qualityScore
  );

  return Math.min(100, finalScore);
}

function getScoreLabel(score) {
  if (score >= 80) return "Strong Match";
  if (score >= 60) return "Moderate Match";
  if (score >= 40) return "Needs Improvement";
  return "Low Match";
}

async function extractTextFromPdf(filePath) {
  const fileData = fs.readFileSync(filePath);
  const dataBuffer = new Uint8Array(fileData);

  const loadingTask = pdfjsLib.getDocument({
    data: dataBuffer,
    disableWorker: true,
  });

  const pdfDoc = await loadingTask.promise;
  let text = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();

    const strings = content.items
      .filter(item => item && typeof item.str === "string")
      .map(item => item.str);

    text += strings.join(" ") + "\n";
  }

  return cleanText(text);
}

app.get("/", (req, res) => {
  res.send("Resume ATS Analyzer API Running 🚀");
});

app.post("/upload", upload.single("resume"), async (req, res) => {
  let filePath = "";

  try {
    console.log("STEP 1: /upload called");

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded",
      });
    }

    const jobDescription = req.body.jobDescription;

    if (!jobDescription || !jobDescription.trim()) {
      return res.status(400).json({
        success: false,
        error: "Job description is required",
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "GROQ_API_KEY is missing in .env file",
      });
    }

    filePath = req.file.path;
    console.log("STEP 2: filePath =", filePath);

    const resumeText = await extractTextFromPdf(filePath);
    console.log("STEP 3: Extracted text length =", resumeText.length);
    console.log("STEP 4: Extracted preview =", resumeText.slice(0, 500));

    if (!resumeText || resumeText.length < 20) {
      return res.status(400).json({
        success: false,
        error: "Could not extract enough text from the resume",
        details: "The PDF may be image-based, empty, or unreadable.",
      });
    }

    console.log("STEP 5: Calling Groq");

    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are a resume analyzer. Extract structured resume skills and suggestions. Return only valid JSON. No markdown, no explanation, no extra text.",
        },
        {
          role: "user",
          content: `
Analyze the resume against the job description.

Rules:
- Extract technicalSkills, toolsAndPlatforms, and softSkills from the resume.
- Do not repeat the same skill in multiple arrays.
- Keep wording concise.
- Give 3 to 5 short improvement suggestions based on the job description.
- Return only valid JSON in exactly this format:

{
  "technicalSkills": [],
  "toolsAndPlatforms": [],
  "softSkills": [],
  "suggestions": []
}

Resume:
${resumeText}

Job Description:
${jobDescription}
          `,
        },
      ],
      temperature: 0,
    });

    console.log("STEP 6: Groq success");

    const rawOutput = response?.choices?.[0]?.message?.content?.trim() || "";
    console.log("STEP 7: Raw output =", rawOutput);

    if (!rawOutput) {
      return res.status(500).json({
        success: false,
        error: "AI returned empty output",
      });
    }

    const jsonStart = rawOutput.indexOf("{");
    const jsonEnd = rawOutput.lastIndexOf("}") + 1;

    if (jsonStart === -1 || jsonEnd === 0) {
      return res.status(500).json({
        success: false,
        error: "AI did not return valid JSON",
        details: rawOutput,
      });
    }

    const cleanJson = rawOutput.slice(jsonStart, jsonEnd);

    let analysisData;
    try {
      analysisData = JSON.parse(cleanJson);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Failed to parse AI JSON",
        details: parseError.message,
        rawOutput: cleanJson,
      });
    }

    analysisData.technicalSkills = normalizeArray(analysisData.technicalSkills);
    analysisData.toolsAndPlatforms = normalizeArray(analysisData.toolsAndPlatforms);
    analysisData.softSkills = normalizeArray(analysisData.softSkills);
    analysisData.suggestions = uniqueArray(analysisData.suggestions);

    const resumeSkills = [
      ...analysisData.technicalSkills,
      ...analysisData.toolsAndPlatforms,
      ...analysisData.softSkills,
    ];

    const jobKeywords = extractJobKeywords(jobDescription);
    const { matched, missing } = compareKeywords(resumeSkills, jobKeywords);

    analysisData.matchedKeywords = matched;
    analysisData.missingKeywords = missing;

    analysisData.atsScore = calculateATSScore({
      matchedKeywords: matched,
      missingKeywords: missing,
      technicalSkills: analysisData.technicalSkills,
      toolsAndPlatforms: analysisData.toolsAndPlatforms,
      softSkills: analysisData.softSkills,
      resumeText,
    });

    analysisData.matchLabel = getScoreLabel(analysisData.atsScore);

    return res.json({
      success: true,
      message: "Resume analyzed successfully",
      data: analysisData,
    });
  } catch (error) {
    console.error("FULL ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to process resume",
      details: error?.error?.message || error?.message || "Unknown server error",
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("STEP 8: Uploaded file deleted");
    }
  }
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});