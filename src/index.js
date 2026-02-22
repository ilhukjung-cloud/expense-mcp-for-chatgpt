import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import puppeteer from "puppeteer";
import puppeteerCore from "puppeteer-core";
import { readFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import os from "os";
import * as driveApi from "./drive.js";

// ---------------------------------------------------------------------------
// Paths & Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Google Drive API 방식 — GDRIVE_BASE 불필요

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

async function loadExpenses() {
  try {
    const data = await driveApi.readJsonFile("expenses.json");
    return data || [];
  } catch {
    return [];
  }
}

async function saveExpenses(expenses) {
  await driveApi.writeJsonFile("expenses.json", expenses);
}

function detectCategory(merchant) {
  const m = merchant;
  if (/식당|음식|한식|중식|일식|분식|치킨|피자|카페|커피|정육/.test(m)) return "식비";
  if (/택시|이동의즐거움|카카오T|우버|주유소|대리운전|톨게이트/.test(m)) return "교통비";
  if (/호텔|숙박|모텔|에어비앤비|여관/.test(m)) return "숙박비";
  if (/오피스디포|문구|다이소|사무용품/.test(m)) return "사무용품비";
  if (/스타벅스|투썸|회의실/.test(m)) return "회의비";
  return "기타";
}

function formatAmount(n) {
  return n.toLocaleString("ko-KR") + "원";
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "expense",
  version: "1.0.0",
});

// ---- 1. save_expense -------------------------------------------------------

server.tool(
  "save_expense",
  "경비 항목 하나를 저장합니다",
  {
    date: z.string().describe("날짜 (YYYY-MM-DD)"),
    merchant: z.string().describe("가맹점/상호명"),
    amount: z.number().describe("금액 (원)"),
    business_number: z.string().optional().describe("사업자등록번호"),
    category: z.string().optional().describe("분류 (미입력 시 자동 감지)"),
    project: z.string().describe("경비 프로젝트명 (예: '출장 경비', '고객 지원 경비', 'AI 솔루션 활용 경비')"),
    receipt_path: z.string().optional().describe("영수증 이미지 상대 경로"),
    notes: z.string().optional().describe("비고"),
  },
  async ({ date, merchant, amount, business_number, category, project, receipt_path, notes }) => {
    const expenses = await loadExpenses();

    const expense = {
      id: uuidv4(),
      date,
      merchant,
      amount,
      business_number: business_number || "",
      category: category || detectCategory(merchant),
      project,
      receipt_path: receipt_path || "",
      notes: notes || "",
      created_at: new Date().toISOString(),
    };

    expenses.push(expense);
    await saveExpenses(expenses);

    // Calculate current month total
    const [y, m] = date.split("-").map(Number);
    const monthTotal = expenses
      .filter((e) => {
        const [ey, em] = e.date.split("-").map(Number);
        return ey === y && em === m && e.project === project;
      })
      .reduce((sum, e) => sum + e.amount, 0);

    return {
      content: [
        {
          type: "text",
          text: [
            `저장 완료`,
            ``,
            `ID: ${expense.id}`,
            `날짜: ${expense.date}`,
            `가맹점: ${expense.merchant}`,
            `금액: ${formatAmount(expense.amount)}`,
            `프로젝트: ${expense.project}`,
            `분류: ${expense.category}`,
            expense.business_number ? `사업자등록번호: ${expense.business_number}` : null,
            expense.receipt_path ? `영수증: ${expense.receipt_path}` : null,
            expense.notes ? `비고: ${expense.notes}` : null,
            ``,
            `${y}년 ${m}월 [${project}] 누적 합계: ${formatAmount(monthTotal)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }
);

// ---- 2. list_expenses ------------------------------------------------------

server.tool(
  "list_expenses",
  "경비 목록을 조회합니다 (필터 가능)",
  {
    year: z.number().optional().describe("연도"),
    month: z.number().optional().describe("월"),
    project: z.string().optional().describe("프로젝트명"),
    category: z.string().optional().describe("분류"),
  },
  async ({ year, month, project, category }) => {
    let expenses = await loadExpenses();

    if (year) {
      expenses = expenses.filter((e) => {
        const ey = Number(e.date.split("-")[0]);
        return ey === year;
      });
    }
    if (month) {
      expenses = expenses.filter((e) => {
        const em = Number(e.date.split("-")[1]);
        return em === month;
      });
    }
    if (category) {
      expenses = expenses.filter((e) => e.category === category);
    }
    if (project) {
      expenses = expenses.filter((e) => e.project === project);
    }

    if (expenses.length === 0) {
      return { content: [{ type: "text", text: "조회 결과가 없습니다." }] };
    }

    // Build table
    const header = "| # | 프로젝트 | 날짜 | 가맹점 | 금액 | 분류 | 비고 |";
    const divider = "|---|---------|------|--------|------|------|------|";
    const rows = expenses.map(
      (e, i) =>
        `| ${i + 1} | ${e.project || ""} | ${e.date} | ${e.merchant} | ${formatAmount(e.amount)} | ${e.category} | ${e.notes || ""} |`
    );

    const total = expenses.reduce((s, e) => s + e.amount, 0);

    const text = [
      header,
      divider,
      ...rows,
      "",
      `총 ${expenses.length}건, 합계: ${formatAmount(total)}`,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ---- 3. get_summary --------------------------------------------------------

server.tool(
  "get_summary",
  "월별 경비 요약 통계를 반환합니다",
  {
    year: z.number().describe("연도"),
    month: z.number().describe("월"),
    project: z.string().optional().describe("프로젝트명 (미입력 시 전체)"),
  },
  async ({ year, month, project }) => {
    const all = await loadExpenses();
    let filtered = all.filter((e) => {
      const [ey, em] = e.date.split("-").map(Number);
      return ey === year && em === month;
    });
    if (project) {
      filtered = filtered.filter((e) => e.project === project);
    }

    const totalCount = filtered.length;
    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);

    // Category breakdown
    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) {
        byCategory[e.category] = { count: 0, amount: 0 };
      }
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }

    const lines = [
      `${year}년 ${month}월 경비 요약${project ? ` [${project}]` : ""}`,
      ``,
      `총 건수: ${totalCount}건`,
      `총 금액: ${formatAmount(totalAmount)}`,
      ``,
      `분류별 내역:`,
      `| 분류 | 건수 | 금액 | 비율 |`,
      `|------|------|------|------|`,
    ];

    for (const [cat, data] of Object.entries(byCategory).sort((a, b) => b[1].amount - a[1].amount)) {
      const pct = totalAmount > 0 ? ((data.amount / totalAmount) * 100).toFixed(1) : "0.0";
      lines.push(`| ${cat} | ${data.count}건 | ${formatAmount(data.amount)} | ${pct}% |`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---- 4. generate_excel_report ---------------------------------------------

server.tool(
  "generate_excel_report",
  "월별 경비 Excel 보고서를 생성합니다",
  {
    year: z.number().describe("연도"),
    month: z.number().describe("월"),
    project: z.string().optional().describe("프로젝트명 (미입력 시 전체)"),
  },
  async ({ year, month, project }) => {
    const all = await loadExpenses();
    let filtered = all.filter((e) => {
      const [ey, em] = e.date.split("-").map(Number);
      return ey === year && em === month;
    });
    if (project) {
      filtered = filtered.filter((e) => e.project === project);
    }

    const wb = XLSX.utils.book_new();

    // --- Detail sheet ---
    const detailData = filtered.map((e) => ({
      날짜: e.date,
      가맹점: e.merchant,
      금액: e.amount,
      사업자등록번호: e.business_number,
      분류: e.category,
      비고: e.notes,
    }));
    const wsDetail = XLSX.utils.json_to_sheet(detailData);

    // Set column widths
    wsDetail["!cols"] = [
      { wch: 12 }, // 날짜
      { wch: 25 }, // 가맹점
      { wch: 15 }, // 금액
      { wch: 18 }, // 사업자등록번호
      { wch: 12 }, // 분류
      { wch: 20 }, // 비고
    ];

    XLSX.utils.book_append_sheet(wb, wsDetail, "경비내역");

    // --- Summary sheet ---
    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) {
        byCategory[e.category] = { count: 0, amount: 0 };
      }
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }

    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);

    const summaryData = Object.entries(byCategory)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([cat, data]) => ({
        분류: cat,
        건수: data.count,
        금액: data.amount,
        "비율(%)": totalAmount > 0 ? Number(((data.amount / totalAmount) * 100).toFixed(1)) : 0,
      }));

    // Add total row
    summaryData.push({
      분류: "합계",
      건수: filtered.length,
      금액: totalAmount,
      "비율(%)": 100,
    });

    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary["!cols"] = [
      { wch: 15 },
      { wch: 10 },
      { wch: 15 },
      { wch: 10 },
    ];

    XLSX.utils.book_append_sheet(wb, wsSummary, "분류별요약");

    const mm = String(month).padStart(2, "0");
    const projectSuffix = project ? `_${project.replace(/\s+/g, "_")}` : "";
    const fileName = `${year}-${mm}${projectSuffix}_경비보고서.xlsx`;

    // /tmp에 생성 후 Drive 업로드
    const tmpPath = join(os.tmpdir(), fileName);
    XLSX.writeFile(wb, tmpPath);

    const reportsFolderId = await driveApi.findOrCreateFolder("reports");
    await driveApi.uploadLocalFile(
      tmpPath, fileName,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      reportsFolderId
    );

    return {
      content: [
        {
          type: "text",
          text: [
            `Excel 보고서 생성 완료 (Google Drive 저장)`,
            ``,
            `파일: reports/${fileName}`,
            `기간: ${year}년 ${month}월`,
            `건수: ${filtered.length}건`,
            `합계: ${formatAmount(totalAmount)}`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- 5. generate_pdf_report ------------------------------------------------

// 공통 헬퍼: receipts_folder 또는 expense.receipt_path 기반으로 영수증 HTML 생성
async function buildReceiptImages(filtered, receiptsFolder) {
  const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];
  const MIME_MAP = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
  const receiptParts = [];

  if (receiptsFolder) {
    // 1순위: reports/<receiptsFolder>, 2순위: 루트/<receiptsFolder>
    let folderId = await driveApi.getFolderIdByPath(["reports", receiptsFolder]);
    let folderLabel = `reports/${receiptsFolder}`;
    if (!folderId) {
      folderId = await driveApi.getFolderIdByName(receiptsFolder);
      folderLabel = receiptsFolder;
    }
    if (!folderId) {
      return { html: `<p class="missing">폴더 '${receiptsFolder}'를 찾을 수 없습니다. Google Drive에서 폴더명을 확인해 주세요.</p>`, count: 0 };
    }
    const files = await driveApi.listFilesInFolder(folderId);
    const images = files.filter(f => IMAGE_EXTS.some(ext => f.name.toLowerCase().endsWith("." + ext)));

    if (images.length === 0) {
      return { html: `<p>폴더 '${folderLabel}'에 이미지가 없습니다.</p>`, count: 0 };
    }

    for (let i = 0; i < images.length; i++) {
      const f = images[i];
      const ext = f.name.split(".").pop().toLowerCase();
      const mime = MIME_MAP[ext] || "image/jpeg";
      try {
        const buf = await driveApi.downloadFileAsBuffer(f.id);
        const b64 = buf.toString("base64");
        receiptParts.push(`
        <div class="receipt">
          <div class="receipt-header">
            <span class="receipt-no">증빙 #${i + 1}</span>
            <span class="receipt-info">${f.name}</span>
            <span class="receipt-amount"></span>
          </div>
          <img src="data:${mime};base64,${b64}" alt="${f.name}" />
        </div>`);
      } catch {
        receiptParts.push(`
        <div class="receipt">
          <div class="receipt-header">
            <span class="receipt-no">증빙 #${i + 1}</span>
            <span class="receipt-info">${f.name}</span>
            <span class="receipt-amount"></span>
          </div>
          <p class="missing">이미지 로드 실패: ${f.name}</p>
        </div>`);
      }
    }
  } else {
    // expense.receipt_path 기반 (기존 방식)
    let receiptNo = 0;
    for (const e of filtered) {
      if (!e.receipt_path) continue;
      receiptNo++;
      try {
        const imgFile = await driveApi.findFileByRelativePath(e.receipt_path);
        if (!imgFile) throw new Error("not found");
        const imgBuffer = await driveApi.downloadFileAsBuffer(imgFile.id);
        const ext = e.receipt_path.split(".").pop().toLowerCase();
        const mime = MIME_MAP[ext] || "image/jpeg";
        const b64 = imgBuffer.toString("base64");
        receiptParts.push(`
        <div class="receipt">
          <div class="receipt-header">
            <span class="receipt-no">증빙 #${receiptNo}</span>
            <span class="receipt-info">${e.date} | ${e.merchant}${e.business_number ? ` | 사업자번호: ${e.business_number}` : ""} | ${e.category}</span>
            <span class="receipt-amount">${formatAmount(e.amount)}</span>
          </div>
          <img src="data:${mime};base64,${b64}" alt="${e.merchant} 영수증" />
        </div>`);
      } catch {
        receiptParts.push(`
        <div class="receipt">
          <div class="receipt-header">
            <span class="receipt-no">증빙 #${receiptNo}</span>
            <span class="receipt-info">${e.date} | ${e.merchant} | ${e.category}</span>
            <span class="receipt-amount">${formatAmount(e.amount)}</span>
          </div>
          <p class="missing">영수증 이미지를 찾을 수 없습니다: ${e.receipt_path}</p>
        </div>`);
      }
    }
  }

  return {
    html: receiptParts.length > 0 ? receiptParts.join("\n") : "<p>첨부된 영수증이 없습니다.</p>",
    count: receiptParts.length,
  };
}

// 공통 헬퍼: Puppeteer로 HTML → PDF 생성 후 Drive 업로드
async function generateAndUploadPdf(html, fileName) {
  let browser;
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    browser = await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  } else {
    browser = await puppeteer.launch({ headless: true });
  }
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });

  const tmpPath = join(os.tmpdir(), fileName);
  await page.pdf({
    path: tmpPath,
    format: "A4",
    printBackground: true,
    margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" },
  });
  await browser.close();

  const reportsFolderId = await driveApi.findOrCreateFolder("reports");
  await driveApi.uploadLocalFile(tmpPath, fileName, "application/pdf", reportsFolderId);
  return tmpPath;
}

server.tool(
  "generate_pdf_report",
  "월별 경비 PDF 보고서를 영수증 이미지와 함께 생성합니다",
  {
    year: z.number().describe("연도"),
    month: z.number().describe("월"),
    project: z.string().optional().describe("프로젝트명 (미입력 시 전체)"),
    receipts_folder: z.string().optional().describe("영수증 폴더명 (Google Drive reports/ 하위 폴더. 예: '2월 영수증'). 지정 시 해당 폴더의 모든 이미지가 PDF에 포함됩니다."),
  },
  async ({ year, month, project, receipts_folder }) => {
    const all = await loadExpenses();
    let filtered = all.filter((e) => {
      const [ey, em] = e.date.split("-").map(Number);
      return ey === year && em === month;
    });
    if (project) {
      filtered = filtered.filter((e) => e.project === project);
    }

    const templatePath = resolve(__dirname, "..", "templates", "report.html");
    let html = await readFile(templatePath, "utf-8");

    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);

    const expenseRows = filtered
      .map(
        (e, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${e.date}</td>
        <td>${e.merchant}</td>
        <td class="amount">${formatAmount(e.amount)}</td>
        <td>${e.business_number}</td>
        <td>${e.category}</td>
        <td>${e.notes}</td>
      </tr>`
      )
      .join("\n");

    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) byCategory[e.category] = { count: 0, amount: 0 };
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }

    const categorySummary = Object.entries(byCategory)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(
        ([cat, data]) => `
      <tr>
        <td>${cat}</td>
        <td>${data.count}건</td>
        <td class="amount">${formatAmount(data.amount)}</td>
        <td>${totalAmount > 0 ? ((data.amount / totalAmount) * 100).toFixed(1) : "0.0"}%</td>
      </tr>`
      )
      .join("\n");

    const { html: receiptImages, count: receiptCount } = await buildReceiptImages(filtered, receipts_folder);

    html = html.replace(/\{\{YEAR\}\}/g, String(year));
    html = html.replace(/\{\{MONTH\}\}/g, String(month).padStart(2, "0"));
    html = html.replace(/\{\{TOTAL_AMOUNT\}\}/g, formatAmount(totalAmount));
    html = html.replace(/\{\{TOTAL_COUNT\}\}/g, String(filtered.length));
    html = html.replace(/\{\{EXPENSE_ROWS\}\}/g, expenseRows);
    html = html.replace(/\{\{CATEGORY_SUMMARY\}\}/g, categorySummary);
    html = html.replace(/\{\{RECEIPT_IMAGES\}\}/g, receiptImages);
    html = html.replace(/\{\{GENERATION_DATE\}\}/g, new Date().toLocaleString("ko-KR"));

    const mm = String(month).padStart(2, "0");
    const projectSuffix = project ? `_${project.replace(/\s+/g, "_")}` : "";
    const fileName = `${year}-${mm}${projectSuffix}_경비보고서.pdf`;

    await generateAndUploadPdf(html, fileName);

    return {
      content: [
        {
          type: "text",
          text: [
            `PDF 보고서 생성 완료 (Google Drive 저장)`,
            ``,
            `파일: reports/${fileName}`,
            `기간: ${year}년 ${month}월`,
            `건수: ${filtered.length}건`,
            `합계: ${formatAmount(totalAmount)}`,
            receipts_folder
              ? `영수증 폴더: reports/${receipts_folder} (${receiptCount}장 포함)`
              : receiptCount > 0
                ? `영수증 이미지: ${receiptCount}장 포함`
                : `영수증 이미지: 없음`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- 6. list_receipt_images ------------------------------------------------

server.tool(
  "list_receipt_images",
  "Google Drive 경비 폴더의 영수증 이미지 목록을 반환합니다",
  {
    folder: z.string().optional().describe("폴더명 (예: '2월 경비'). 미입력 시 이미지가 있는 모든 폴더 검색"),
  },
  async ({ folder, in_reports }) => {
    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".pdf", ".webp"];

    if (folder) {
      // "reports/폴더명" 형식 지원
      const parts = folder.split("/");
      const folderId = parts.length >= 2
        ? await driveApi.getFolderIdByPath(parts)
        : await driveApi.getFolderIdByName(folder);

      if (!folderId) {
        return { content: [{ type: "text", text: `'${folder}' 폴더를 찾을 수 없습니다.` }], isError: true };
      }
      const files = await driveApi.listFilesInFolder(folderId);
      const images = files.filter((f) => imageExts.some((ext) => f.name.toLowerCase().endsWith(ext)));

      if (images.length === 0) {
        return { content: [{ type: "text", text: `'${folder}' 폴더에 이미지가 없습니다.` }] };
      }
      const lines = images.map((f, i) => `${i + 1}. ${f.name}`);
      return {
        content: [{ type: "text", text: [`'${folder}' 폴더 이미지 (${images.length}개):`, "", ...lines, "", `💡 PDF 보고서 생성 시: receipts_folder: "${parts[parts.length - 1]}" 로 지정하세요.`].join("\n") }],
      };
    }

    const results = [];

    // 루트의 모든 서브폴더 검색 (이미지가 있는 폴더만)
    const subfolders = await driveApi.listSubfolders();
    for (const sf of subfolders) {
      const files = await driveApi.listFilesInFolder(sf.id);
      const images = files.filter((f) => imageExts.some((ext) => f.name.toLowerCase().endsWith(ext)));
      if (images.length > 0) {
        results.push(`📁 ${sf.name}/ (${images.length}개) ← receipts_folder: "${sf.name}"`);
        for (const f of images) results.push(`   - ${f.name}`);
        results.push("");
      }
    }

    // reports/ 하위 서브폴더도 검색
    const reportsFolderId = await driveApi.getFolderIdByName("reports");
    if (reportsFolderId) {
      const subfolders2 = await driveApi.listSubfoldersInFolder(reportsFolderId);
      for (const sf of subfolders2) {
        const files = await driveApi.listFilesInFolder(sf.id);
        const images = files.filter((f) => imageExts.some((ext) => f.name.toLowerCase().endsWith(ext)));
        if (images.length > 0) {
          results.push(`📁 reports/${sf.name}/ (${images.length}개) ← receipts_folder: "${sf.name}"`);
          for (const f of images) results.push(`   - ${f.name}`);
          results.push("");
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: "이미지가 있는 폴더를 찾을 수 없습니다.\n\n💡 Google Drive에 영수증 이미지가 담긴 폴더가 있는지 확인해 주세요." }] };
    }
    return {
      content: [{ type: "text", text: ["Google Drive 영수증 이미지:", "", ...results].join("\n") }],
    };
  }
);

// ---- 7. save_receipt_image -------------------------------------------------

server.tool(
  "save_receipt_image",
  "로컬 이미지 파일을 Google Drive 경비 폴더로 복사하고 상대 경로를 반환합니다",
  {
    source_path: z.string().describe("복사할 원본 이미지의 절대 경로"),
    folder: z.string().optional().describe("저장할 폴더명 (기본: '{월}월 경비')"),
    filename: z.string().optional().describe("저장할 파일명 (기본: 원본 파일명)"),
  },
  async ({ source_path, folder, filename }) => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const targetFolder = folder || `${month}월 경비`;
    const srcFilename = source_path.split("/").pop();
    const targetFilename = filename || srcFilename;

    try {
      await driveApi.copyLocalImageToDrive(source_path, targetFilename, targetFolder);
    } catch (err) {
      return {
        content: [{ type: "text", text: `파일 업로드 실패: ${err.message}\n원본: ${source_path}` }],
        isError: true,
      };
    }

    const relativePath = `${targetFolder}/${targetFilename}`;
    return {
      content: [
        {
          type: "text",
          text: [
            `영수증 이미지 저장 완료 (Google Drive 업로드)`,
            ``,
            `원본: ${source_path}`,
            `Drive 저장 위치: ${relativePath}`,
            ``,
            `save_expense 호출 시 receipt_path에 "${relativePath}"를 사용하세요.`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- 8. scan_receipt_folder ------------------------------------------------

server.tool(
  "scan_receipt_folder",
  "영수증 폴더를 스캔하여 처리됨/미처리 상태를 구분합니다",
  {
    folder: z.string().describe("스캔할 폴더명 (예: '2월 경비')"),
  },
  async ({ folder }) => {
    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".pdf"];

    const folderId = await driveApi.getFolderIdByName(folder);
    if (!folderId) {
      return {
        content: [{ type: "text", text: `'${folder}' 폴더를 찾을 수 없습니다.` }],
        isError: true,
      };
    }

    const allFiles = await driveApi.listFilesInFolder(folderId);
    const images = allFiles.filter((f) => imageExts.some((ext) => f.name.toLowerCase().endsWith(ext)));

    if (images.length === 0) {
      return { content: [{ type: "text", text: `'${folder}' 폴더에 이미지가 없습니다.` }] };
    }

    const expenses = await loadExpenses();

    const processed = [];
    const unprocessed = [];

    for (const img of images) {
      const relativePath = `${folder}/${img.name}`;
      const linked = expenses.find((e) => e.receipt_path === relativePath);
      if (linked) {
        processed.push({
          file: img.name,
          path: relativePath,
          expense_id: linked.id,
          date: linked.date,
          merchant: linked.merchant,
          amount: linked.amount,
          business_number: linked.business_number,
        });
      } else {
        unprocessed.push({ file: img.name, path: relativePath });
      }
    }

    const lines = [];
    lines.push(`📁 ${folder}/ 스캔 결과`);
    lines.push(`전체: ${images.length}개 | 처리됨: ${processed.length}개 | 미처리: ${unprocessed.length}개`);
    lines.push("");

    if (unprocessed.length > 0) {
      lines.push(`⬜ 미처리 (${unprocessed.length}개):`);
      for (const u of unprocessed) {
        lines.push(`  - ${u.file}`);
      }
      lines.push("");
    }

    if (processed.length > 0) {
      lines.push(`✅ 처리됨 (${processed.length}개):`);
      for (const p of processed) {
        const biz = p.business_number ? ` | 사업자: ${p.business_number}` : "";
        lines.push(`  - ${p.file} → ${p.date} ${p.merchant} ${formatAmount(p.amount)}${biz}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---- 9. lookup_by_receipt --------------------------------------------------

server.tool(
  "lookup_by_receipt",
  "영수증 파일명 또는 경로로 경비 데이터를 조회합니다",
  {
    query: z.string().describe("검색할 영수증 파일명 또는 경로 (부분 일치 가능, 예: 'IMG_3672')"),
  },
  async ({ query }) => {
    const expenses = await loadExpenses();
    const matches = expenses.filter(
      (e) => e.receipt_path && e.receipt_path.toLowerCase().includes(query.toLowerCase())
    );

    if (matches.length === 0) {
      return {
        content: [{ type: "text", text: `'${query}'와 일치하는 영수증 경비를 찾을 수 없습니다.` }],
      };
    }

    const lines = [`'${query}' 검색 결과 (${matches.length}건):`, ""];
    for (const e of matches) {
      lines.push(`📎 ${e.receipt_path}`);
      lines.push(`  ID: ${e.id}`);
      lines.push(`  날짜: ${e.date}`);
      lines.push(`  가맹점: ${e.merchant}`);
      lines.push(`  금액: ${formatAmount(e.amount)}`);
      if (e.business_number) lines.push(`  사업자번호: ${e.business_number}`);
      lines.push(`  분류: ${e.category}`);
      if (e.notes) lines.push(`  비고: ${e.notes}`);
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---- 10. list_projects -----------------------------------------------------

server.tool(
  "list_projects",
  "등록된 경비 프로젝트 목록과 각 프로젝트별 요약을 반환합니다",
  {
    year: z.number().optional().describe("연도"),
    month: z.number().optional().describe("월"),
  },
  async ({ year, month }) => {
    let expenses = await loadExpenses();

    if (year) {
      expenses = expenses.filter((e) => Number(e.date.split("-")[0]) === year);
    }
    if (month) {
      expenses = expenses.filter((e) => Number(e.date.split("-")[1]) === month);
    }

    const byProject = {};
    for (const e of expenses) {
      const p = e.project || "(미지정)";
      if (!byProject[p]) {
        byProject[p] = { count: 0, amount: 0 };
      }
      byProject[p].count += 1;
      byProject[p].amount += e.amount;
    }

    if (Object.keys(byProject).length === 0) {
      return { content: [{ type: "text", text: "등록된 프로젝트가 없습니다." }] };
    }

    const totalAmount = expenses.reduce((s, e) => s + e.amount, 0);

    const lines = [
      `프로젝트별 경비 현황${year ? ` (${year}년${month ? ` ${month}월` : ""})` : ""}:`,
      "",
      "| 프로젝트 | 건수 | 금액 | 비율 |",
      "|---------|------|------|------|",
    ];

    for (const [proj, data] of Object.entries(byProject).sort((a, b) => b[1].amount - a[1].amount)) {
      const pct = totalAmount > 0 ? ((data.amount / totalAmount) * 100).toFixed(1) : "0.0";
      lines.push(`| ${proj} | ${data.count}건 | ${formatAmount(data.amount)} | ${pct}% |`);
    }

    lines.push("");
    lines.push(`총 ${Object.keys(byProject).length}개 프로젝트, ${expenses.length}건, 합계: ${formatAmount(totalAmount)}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---- 11. update_expense -----------------------------------------------------

server.tool(
  "update_expense",
  "기존 경비 항목을 수정합니다 (사업자번호, 영수증 경로 등 부분 업데이트 가능)",
  {
    id: z.string().describe("수정할 경비 항목의 ID"),
    date: z.string().optional().describe("날짜 (YYYY-MM-DD)"),
    merchant: z.string().optional().describe("가맹점/상호명"),
    amount: z.number().optional().describe("금액 (원)"),
    business_number: z.string().optional().describe("사업자등록번호"),
    category: z.string().optional().describe("분류"),
    project: z.string().optional().describe("경비 프로젝트명"),
    receipt_path: z.string().optional().describe("영수증 이미지 상대 경로"),
    notes: z.string().optional().describe("비고"),
  },
  async ({ id, date, merchant, amount, business_number, category, project, receipt_path, notes }) => {
    const expenses = await loadExpenses();
    const idx = expenses.findIndex((e) => e.id === id);

    if (idx === -1) {
      return {
        content: [{ type: "text", text: `ID '${id}'에 해당하는 경비 항목을 찾을 수 없습니다.` }],
        isError: true,
      };
    }

    const before = { ...expenses[idx] };
    const updates = [];

    if (date !== undefined) { expenses[idx].date = date; updates.push(`날짜: ${before.date} → ${date}`); }
    if (merchant !== undefined) { expenses[idx].merchant = merchant; updates.push(`가맹점: ${before.merchant} → ${merchant}`); }
    if (amount !== undefined) { expenses[idx].amount = amount; updates.push(`금액: ${formatAmount(before.amount)} → ${formatAmount(amount)}`); }
    if (business_number !== undefined) { expenses[idx].business_number = business_number; updates.push(`사업자번호: ${before.business_number || "(없음)"} → ${business_number}`); }
    if (category !== undefined) { expenses[idx].category = category; updates.push(`분류: ${before.category} → ${category}`); }
    if (project !== undefined) { expenses[idx].project = project; updates.push(`프로젝트: ${before.project || "(없음)"} → ${project}`); }
    if (receipt_path !== undefined) { expenses[idx].receipt_path = receipt_path; updates.push(`영수증: ${before.receipt_path || "(없음)"} → ${receipt_path}`); }
    if (notes !== undefined) { expenses[idx].notes = notes; updates.push(`비고: ${before.notes || "(없음)"} → ${notes}`); }

    if (updates.length === 0) {
      return { content: [{ type: "text", text: "수정할 항목이 없습니다." }] };
    }

    await saveExpenses(expenses);

    return {
      content: [
        {
          type: "text",
          text: [
            `수정 완료 (${updates.length}개 항목)`,
            ``,
            `ID: ${id}`,
            `가맹점: ${expenses[idx].merchant}`,
            ``,
            `변경 내역:`,
            ...updates.map((u) => `  - ${u}`),
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- 12. delete_expense -----------------------------------------------------

server.tool(
  "delete_expense",
  "경비 항목을 ID로 삭제합니다",
  {
    id: z.string().describe("삭제할 경비 항목의 ID"),
  },
  async ({ id }) => {
    const expenses = await loadExpenses();
    const idx = expenses.findIndex((e) => e.id === id);

    if (idx === -1) {
      return {
        content: [{ type: "text", text: `ID '${id}'에 해당하는 경비 항목을 찾을 수 없습니다.` }],
        isError: true,
      };
    }

    const [deleted] = expenses.splice(idx, 1);
    await saveExpenses(expenses);

    return {
      content: [
        {
          type: "text",
          text: [
            `삭제 완료`,
            ``,
            `ID: ${deleted.id}`,
            `날짜: ${deleted.date}`,
            `가맹점: ${deleted.merchant}`,
            `금액: ${formatAmount(deleted.amount)}`,
            `분류: ${deleted.category}`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ---- 13. help ---------------------------------------------------------------

server.tool(
  "help",
  "경비 관리 시스템의 사용법과 도구 목록을 안내합니다",
  {
    tool_name: z.string().optional().describe("특정 도구의 상세 사용법 (예: 'save_expense')"),
  },
  async ({ tool_name }) => {
    const toolDetails = {
      save_expense: {
        summary: "경비 항목 하나를 저장합니다",
        params: "date(필수), merchant(필수), amount(필수), project(필수), business_number, category, receipt_path, notes",
        example: "날짜: 2026-02-05, 가맹점: 분당한우정육식당, 금액: 103500, 프로젝트: 출장 경비",
        tips: "category 미입력 시 가맹점명으로 자동 분류됩니다. project는 반드시 지정해야 합니다.",
      },
      list_expenses: {
        summary: "저장된 경비 목록을 조회합니다",
        params: "year, month, category, project (모두 선택)",
        example: "2월 경비 조회 → year: 2026, month: 2",
        tips: "project 필터로 특정 프로젝트의 경비만 조회할 수 있습니다.",
      },
      get_summary: {
        summary: "월별 경비 요약 통계를 조회합니다",
        params: "year(필수), month(필수), project(선택)",
        example: "year: 2026, month: 2 → 카테고리별 건수/금액 집계",
        tips: "project 필터로 프로젝트별 요약도 가능합니다.",
      },
      generate_excel_report: {
        summary: "월별 Excel 경비 보고서를 생성합니다",
        params: "year(필수), month(필수), project(선택)",
        example: "year: 2026, month: 2, project: 'AI 솔루션 활용 경비'",
        tips: "project 지정 시 파일명에 프로젝트명이 포함됩니다. reports/ 폴더에 저장됩니다.",
      },
      generate_pdf_report: {
        summary: "월별 PDF 경비 보고서를 생성합니다 (영수증 이미지 포함)",
        params: "year(필수), month(필수), project(선택), receipts_folder(선택)",
        example: "year: 2026, month: 2, receipts_folder: '2월 영수증'",
        tips: "receipts_folder 지정 시 Google Drive reports/{폴더}의 모든 이미지가 PDF에 포함됩니다. 미지정 시 각 경비의 receipt_path 기준.",
      },
      list_receipt_images: {
        summary: "Google Drive의 영수증 이미지 목록을 조회합니다",
        params: "folder(선택), in_reports(선택, true 시 reports/ 하위만 검색)",
        example: "in_reports: true  또는  folder: 'reports/2월 영수증'",
        tips: "in_reports: true 로 호출하면 PDF 생성 시 사용할 receipts_folder 값을 안내해 줍니다.",
      },
      save_receipt_image: {
        summary: "로컬 이미지 파일을 Google Drive 경비 폴더로 복사합니다",
        params: "source_path(필수), folder(선택)",
        example: "source_path: '/tmp/receipt.png', folder: '2월 경비'",
        tips: "이미 Google Drive에 있는 영수증은 이 도구가 필요 없습니다.",
      },
      scan_receipt_folder: {
        summary: "영수증 폴더를 스캔하여 처리/미처리 상태를 확인합니다",
        params: "folder(선택)",
        example: "folder: '2월 경비' → 각 이미지의 처리 여부 표시",
        tips: "expenses.json의 receipt_path와 대조하여 처리 상태를 판단합니다.",
      },
      lookup_by_receipt: {
        summary: "영수증 파일명으로 경비를 검색합니다",
        params: "filename(필수)",
        example: "filename: 'IMG_3672.PNG'",
        tips: "부분 일치로 검색됩니다.",
      },
      list_projects: {
        summary: "프로젝트별 경비 요약을 조회합니다",
        params: "year, month (모두 선택)",
        example: "year: 2026, month: 2 → 프로젝트별 건수/금액",
        tips: "어떤 프로젝트가 있는지, 각각의 금액이 얼마인지 한눈에 파악할 수 있습니다.",
      },
      update_expense: {
        summary: "기존 경비 항목을 부분 수정합니다",
        params: "id(필수), date, merchant, amount, business_number, category, project, receipt_path, notes (수정할 항목만)",
        example: "id: '550e8400...', project: '출장 경비'",
        tips: "프로젝트 변경, 사업자번호 추가, 영수증 연결 등에 사용합니다.",
      },
      delete_expense: {
        summary: "경비 항목을 ID로 삭제합니다",
        params: "id(필수)",
        example: "id: '550e8400...'",
        tips: "삭제 전 list_expenses로 ID를 확인하세요.",
      },
      help: {
        summary: "이 도움말을 표시합니다",
        params: "tool_name(선택)",
        example: "tool_name: 'save_expense'",
        tips: "도구명 없이 호출하면 전체 목록을, 도구명을 지정하면 상세 사용법을 보여줍니다.",
      },
    };

    if (tool_name) {
      const detail = toolDetails[tool_name];
      if (!detail) {
        return {
          content: [{ type: "text", text: `'${tool_name}' 도구를 찾을 수 없습니다.\n\n사용 가능한 도구: ${Object.keys(toolDetails).join(", ")}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: [
            `📌 ${tool_name}`,
            ``,
            `설명: ${detail.summary}`,
            `파라미터: ${detail.params}`,
            `사용 예: ${detail.example}`,
            `팁: ${detail.tips}`,
          ].join("\n"),
        }],
      };
    }

    const lines = [
      "경비 관리 시스템 도구 안내",
      "=".repeat(40),
      "",
      "📁 경비 등록/수정/삭제",
      "  • save_expense    — 경비 1건 저장 (project 필수)",
      "  • update_expense  — 기존 경비 수정 (부분 업데이트)",
      "  • delete_expense  — 경비 삭제",
      "",
      "📊 조회/통계",
      "  • list_expenses   — 경비 목록 조회 (project/월/카테고리 필터)",
      "  • get_summary     — 월별 요약 통계",
      "  • list_projects   — 프로젝트별 요약 (건수, 금액)",
      "",
      "📄 보고서 생성",
      "  • generate_excel_report — Excel 보고서",
      "  • generate_pdf_report   — PDF 보고서 (영수증 포함)",
      "",
      "🖼️ 영수증 관리",
      "  • list_receipt_images  — 영수증 이미지 목록",
      "  • save_receipt_image   — 로컬 이미지 → Google Drive 복사",
      "  • scan_receipt_folder  — 폴더 스캔 (처리/미처리 상태)",
      "  • lookup_by_receipt    — 영수증 파일명으로 경비 검색",
      "",
      "❓ 도움말",
      "  • help — 사용법 안내 (tool_name 지정 시 상세 설명)",
      "",
      "💡 특정 도구의 상세 사용법: help(tool_name: '도구명')",
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// HTTP Server (ChatGPT Enterprise / Streamable HTTP)
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization"],
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Lazy initialization (Vercel 서버리스 호환)
let transport = null;

async function getTransport() {
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    await server.connect(transport);
  }
  return transport;
}

app.all("/mcp", async (req, res) => {
  try {
    const t = await getTransport();
    await t.handleRequest(req, res);
  } catch (error) {
    console.error("MCP Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    name: "expense-mcp-server",
    mode: "Google Drive API",
    folder: process.env.GDRIVE_FOLDER_ID ? "configured" : "NOT SET",
  });
});

// ---------------------------------------------------------------------------
// OAuth2 인증 (Refresh Token 발급용)
// ---------------------------------------------------------------------------

app.get("/auth", async (req, res) => {
  const { google } = await import("googleapis");
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `https://expense-mcp-for-chatgpt.vercel.app/auth/callback`
  );
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { google } = await import("googleapis");
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `https://expense-mcp-for-chatgpt.vercel.app/auth/callback`
    );
    const { tokens } = await oauth2.getToken(req.query.code);
    res.send(`
      <h2>✅ 인증 성공!</h2>
      <p>아래 Refresh Token을 복사해서 Vercel 환경변수 <strong>GOOGLE_REFRESH_TOKEN</strong>에 설정하세요:</p>
      <textarea rows="4" cols="80" onclick="this.select()">${tokens.refresh_token}</textarea>
      <br><br>
      <p>설정 후 <code>vercel --prod</code>로 재배포하면 완료됩니다.</p>
    `);
  } catch (err) {
    res.status(500).send(`인증 실패: ${err.message}`);
  }
});

app.get("/test-drive", async (req, res) => {
  const result = { folder_id: process.env.GDRIVE_FOLDER_ID || "NOT SET", steps: [] };
  try {
    result.steps.push("1. 서비스 계정 키 파싱 시도");
    const { google } = await import("googleapis");
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, "base64").toString("utf-8")
    );
    result.service_account_email = credentials.client_email;
    result.steps.push("2. 인증 완료");

    const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] });
    const drive = google.drive({ version: "v3", auth });
    result.steps.push("3. Drive 클라이언트 생성 완료");

    const folderRes = await drive.files.get({
      fileId: process.env.GDRIVE_FOLDER_ID,
      fields: "id, name, mimeType",
    });
    result.folder_name = folderRes.data.name;
    result.steps.push("4. 폴더 접근 성공 ✅");

    const fileList = await drive.files.list({
      q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: "files(id, name)",
      pageSize: 5,
    });
    result.files_in_folder = fileList.data.files.map(f => f.name);
    result.steps.push("5. 파일 목록 조회 성공 ✅");
    result.status = "OK";
  } catch (err) {
    result.error = err.message;
    result.status = "FAILED";
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// REST API (ChatGPT Custom GPT Actions)
// ---------------------------------------------------------------------------

app.post("/api/save_expense", async (req, res) => {
  try {
    const { date, merchant, amount, business_number, category, project, receipt_path, notes } = req.body;
    if (!date || !merchant || !amount || !project)
      return res.status(400).json({ error: "date, merchant, amount, project 는 필수입니다." });
    const expenses = await loadExpenses();
    const expense = {
      id: uuidv4(), date, merchant,
      amount: Number(amount),
      business_number: business_number || "",
      category: category || detectCategory(merchant),
      project, receipt_path: receipt_path || "",
      notes: notes || "",
      created_at: new Date().toISOString(),
    };
    expenses.push(expense);
    await saveExpenses(expenses);
    const [y, m] = date.split("-").map(Number);
    const monthTotal = expenses
      .filter(e => { const [ey, em] = e.date.split("-").map(Number); return ey === y && em === m && e.project === project; })
      .reduce((s, e) => s + e.amount, 0);
    res.json({ success: true, expense, month_total_formatted: formatAmount(monthTotal) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/list_expenses", async (req, res) => {
  try {
    let expenses = await loadExpenses();
    const { year, month, project, category } = req.query;
    if (year)     expenses = expenses.filter(e => Number(e.date.split("-")[0]) === Number(year));
    if (month)    expenses = expenses.filter(e => Number(e.date.split("-")[1]) === Number(month));
    if (category) expenses = expenses.filter(e => e.category === category);
    if (project)  expenses = expenses.filter(e => e.project === project);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    res.json({ count: expenses.length, total_formatted: formatAmount(total), expenses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/get_summary", async (req, res) => {
  try {
    const { year, month, project } = req.query;
    if (!year || !month) return res.status(400).json({ error: "year, month 는 필수입니다." });
    const all = await loadExpenses();
    let filtered = all.filter(e => {
      const [ey, em] = e.date.split("-").map(Number);
      return ey === Number(year) && em === Number(month);
    });
    if (project) filtered = filtered.filter(e => e.project === project);
    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);
    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) byCategory[e.category] = { count: 0, amount: 0 };
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }
    const by_category = Object.entries(byCategory)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([cat, d]) => ({ category: cat, count: d.count, amount_formatted: formatAmount(d.amount), ratio: totalAmount > 0 ? Number(((d.amount / totalAmount) * 100).toFixed(1)) : 0 }));
    res.json({ year: Number(year), month: Number(month), project: project || "전체", total_count: filtered.length, total_formatted: formatAmount(totalAmount), by_category });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/list_projects", async (req, res) => {
  try {
    let expenses = await loadExpenses();
    const { year, month } = req.query;
    if (year)  expenses = expenses.filter(e => Number(e.date.split("-")[0]) === Number(year));
    if (month) expenses = expenses.filter(e => Number(e.date.split("-")[1]) === Number(month));
    const byProject = {};
    for (const e of expenses) {
      const p = e.project || "(미지정)";
      if (!byProject[p]) byProject[p] = { count: 0, amount: 0 };
      byProject[p].count += 1; byProject[p].amount += e.amount;
    }
    const totalAmount = expenses.reduce((s, e) => s + e.amount, 0);
    const projects = Object.entries(byProject)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([name, d]) => ({ name, count: d.count, amount_formatted: formatAmount(d.amount), ratio: totalAmount > 0 ? Number(((d.amount / totalAmount) * 100).toFixed(1)) : 0 }));
    res.json({ project_count: projects.length, total_formatted: formatAmount(totalAmount), projects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/expense/:id", async (req, res) => {
  try {
    const expenses = await loadExpenses();
    const idx = expenses.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "해당 경비를 찾을 수 없습니다." });
    for (const f of ["date","merchant","amount","business_number","category","project","receipt_path","notes"]) {
      if (req.body[f] !== undefined) expenses[idx][f] = req.body[f];
    }
    await saveExpenses(expenses);
    res.json({ success: true, expense: expenses[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/expense/:id", async (req, res) => {
  try {
    const expenses = await loadExpenses();
    const idx = expenses.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "해당 경비를 찾을 수 없습니다." });
    const [deleted] = expenses.splice(idx, 1);
    await saveExpenses(expenses);
    res.json({ success: true, deleted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 영수증 이미지 업로드 (base64)
app.post("/api/upload_receipt", async (req, res) => {
  try {
    const { data, filename, folder } = req.body;
    if (!filename) return res.status(400).json({ error: "filename 은 필수입니다." });
    if (!data) return res.status(400).json({ error: "data(base64 이미지) 는 필수입니다." });

    const now = new Date();
    const targetFolder = folder || `${now.getMonth() + 1}월 경비`;

    // base64 헤더 제거 (data:image/jpeg;base64, 형식 지원)
    const base64Clean = data.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(base64Clean, "base64");

    // 확장자로 MIME 타입 결정
    const ext = filename.split(".").pop().toLowerCase();
    const mimeMap = {
      png: "image/png",
      jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif",
      pdf: "application/pdf",
      heic: "image/heic", heif: "image/heif",
      webp: "image/webp",
      bmp: "image/bmp",
    };
    const mimeType = mimeMap[ext] || "image/jpeg";

    const folderId = await driveApi.findOrCreateFolder(targetFolder);
    await driveApi.uploadBuffer(buffer, filename, mimeType, folderId);

    const receipt_path = `${targetFolder}/${filename}`;
    res.json({
      success: true,
      receipt_path,
      folder: targetFolder,
      filename,
      message: `영수증이 Google Drive '${targetFolder}' 폴더에 저장됐습니다. save_expense 호출 시 receipt_path: "${receipt_path}" 를 사용하세요.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/generate_pdf_report", async (req, res) => {
  try {
    const { year, month, project, receipts_folder } = req.body;
    if (!year || !month) return res.status(400).json({ error: "year, month 는 필수입니다." });
    const all = await loadExpenses();
    let filtered = all.filter(e => { const [ey, em] = e.date.split("-").map(Number); return ey === Number(year) && em === Number(month); });
    if (project) filtered = filtered.filter(e => e.project === project);

    const templatePath = resolve(__dirname, "..", "templates", "report.html");
    let html = await readFile(templatePath, "utf-8");
    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);

    const expenseRows = filtered.map((e, i) => `
      <tr>
        <td>${i + 1}</td><td>${e.date}</td><td>${e.merchant}</td>
        <td class="amount">${formatAmount(e.amount)}</td>
        <td>${e.business_number}</td><td>${e.category}</td><td>${e.notes}</td>
      </tr>`).join("\n");

    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) byCategory[e.category] = { count: 0, amount: 0 };
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }
    const categorySummary = Object.entries(byCategory)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([cat, data]) => `
      <tr>
        <td>${cat}</td><td>${data.count}건</td>
        <td class="amount">${formatAmount(data.amount)}</td>
        <td>${totalAmount > 0 ? ((data.amount / totalAmount) * 100).toFixed(1) : "0.0"}%</td>
      </tr>`).join("\n");

    const { html: receiptImages, count: receiptCount } = await buildReceiptImages(filtered, receipts_folder);

    html = html.replace(/\{\{YEAR\}\}/g, String(year));
    html = html.replace(/\{\{MONTH\}\}/g, String(month).padStart(2, "0"));
    html = html.replace(/\{\{TOTAL_AMOUNT\}\}/g, formatAmount(totalAmount));
    html = html.replace(/\{\{TOTAL_COUNT\}\}/g, String(filtered.length));
    html = html.replace(/\{\{EXPENSE_ROWS\}\}/g, expenseRows);
    html = html.replace(/\{\{CATEGORY_SUMMARY\}\}/g, categorySummary);
    html = html.replace(/\{\{RECEIPT_IMAGES\}\}/g, receiptImages);
    html = html.replace(/\{\{GENERATION_DATE\}\}/g, new Date().toLocaleString("ko-KR"));

    const mm = String(month).padStart(2, "0");
    const suffix = project ? `_${project.replace(/\s+/g, "_")}` : "";
    const fileName = `${year}-${mm}${suffix}_경비보고서.pdf`;

    await generateAndUploadPdf(html, fileName);

    res.json({
      success: true,
      file: `reports/${fileName}`,
      count: filtered.length,
      total_formatted: formatAmount(totalAmount),
      receipts_folder: receipts_folder || null,
      receipt_count: receiptCount,
      message: `PDF 보고서가 Google Drive reports 폴더에 저장됐습니다. 영수증 ${receiptCount}장 포함.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/generate_excel_report", async (req, res) => {
  try {
    const { year, month, project } = req.body;
    if (!year || !month) return res.status(400).json({ error: "year, month 는 필수입니다." });
    const all = await loadExpenses();
    let filtered = all.filter(e => { const [ey, em] = e.date.split("-").map(Number); return ey === Number(year) && em === Number(month); });
    if (project) filtered = filtered.filter(e => e.project === project);

    const wb = XLSX.utils.book_new();

    // --- 경비내역 시트 ---
    const detailData = filtered.map(e => ({
      날짜: e.date,
      가맹점: e.merchant,
      금액: e.amount,
      사업자등록번호: e.business_number,
      분류: e.category,
      프로젝트: e.project,
      비고: e.notes,
    }));
    const wsDetail = XLSX.utils.json_to_sheet(detailData);
    wsDetail["!cols"] = [{ wch: 12 }, { wch: 25 }, { wch: 15 }, { wch: 18 }, { wch: 12 }, { wch: 20 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsDetail, "경비내역");

    // --- 분류별요약 시트 ---
    const byCategory = {};
    for (const e of filtered) {
      if (!byCategory[e.category]) byCategory[e.category] = { count: 0, amount: 0 };
      byCategory[e.category].count += 1;
      byCategory[e.category].amount += e.amount;
    }
    const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);
    const summaryData = Object.entries(byCategory)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([cat, d]) => ({
        분류: cat,
        건수: d.count,
        금액: d.amount,
        "비율(%)": totalAmount > 0 ? Number(((d.amount / totalAmount) * 100).toFixed(1)) : 0,
      }));
    summaryData.push({ 분류: "합계", 건수: filtered.length, 금액: totalAmount, "비율(%)": 100 });
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary["!cols"] = [{ wch: 15 }, { wch: 10 }, { wch: 15 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "분류별요약");

    const mm = String(month).padStart(2, "0");
    const suffix = project ? `_${project.replace(/\s+/g, "_")}` : "";
    const fileName = `${year}-${mm}${suffix}_경비보고서.xlsx`;
    const tmpPath = join(os.tmpdir(), fileName);
    XLSX.writeFile(wb, tmpPath);

    const folderId = await driveApi.findOrCreateFolder("reports");
    await driveApi.uploadLocalFile(
      tmpPath, fileName,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      folderId
    );

    res.json({
      success: true,
      file: `reports/${fileName}`,
      count: filtered.length,
      total_formatted: formatAmount(totalAmount),
      sheets: ["경비내역", "분류별요약"],
      message: `Excel 보고서가 Google Drive reports 폴더에 저장됐습니다.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// OpenAPI Schema (ChatGPT "URL 가져오기" 전용)
// ---------------------------------------------------------------------------

app.get("/openapi.json", (req, res) => {
  const BASE = "https://expense-mcp-for-chatgpt.vercel.app";
  res.json({
    openapi: "3.1.0",
    info: { title: "경비 관리 시스템", version: "1.0.0", description: "ChatGPT Enterprise용 경비 관리 도구 - 경비 저장, 조회, 보고서 생성" },
    servers: [{ url: BASE }],
    paths: {
      "/api/save_expense": {
        post: {
          operationId: "save_expense",
          summary: "경비 저장",
          description: "경비 항목 하나를 저장합니다",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["date","merchant","amount","project"], properties: {
              date: { type: "string", description: "날짜 (YYYY-MM-DD)" },
              merchant: { type: "string", description: "가맹점명" },
              amount: { type: "number", description: "금액 (원)" },
              project: { type: "string", description: "프로젝트명" },
              business_number: { type: "string", description: "사업자등록번호" },
              category: { type: "string", description: "분류 (미입력 시 자동)" },
              receipt_path: { type: "string", description: "영수증 경로" },
              notes: { type: "string", description: "비고" },
            }}}}
          },
          responses: { "200": { description: "저장 성공" } }
        }
      },
      "/api/list_expenses": {
        get: {
          operationId: "list_expenses",
          summary: "경비 목록 조회",
          parameters: [
            { name: "year", in: "query", schema: { type: "integer" }, description: "연도" },
            { name: "month", in: "query", schema: { type: "integer" }, description: "월" },
            { name: "project", in: "query", schema: { type: "string" }, description: "프로젝트명" },
            { name: "category", in: "query", schema: { type: "string" }, description: "분류" },
          ],
          responses: { "200": { description: "경비 목록" } }
        }
      },
      "/api/get_summary": {
        get: {
          operationId: "get_summary",
          summary: "월별 경비 요약",
          parameters: [
            { name: "year", in: "query", required: true, schema: { type: "integer" } },
            { name: "month", in: "query", required: true, schema: { type: "integer" } },
            { name: "project", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "요약 통계" } }
        }
      },
      "/api/list_projects": {
        get: {
          operationId: "list_projects",
          summary: "프로젝트별 경비 현황",
          parameters: [
            { name: "year", in: "query", schema: { type: "integer" } },
            { name: "month", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "프로젝트 목록" } }
        }
      },
      "/api/expense/{id}": {
        patch: {
          operationId: "update_expense",
          summary: "경비 수정",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: {
            date: { type: "string" }, merchant: { type: "string" }, amount: { type: "number" },
            category: { type: "string" }, project: { type: "string" }, notes: { type: "string" },
          }}}}},
          responses: { "200": { description: "수정 성공" } }
        },
        delete: {
          operationId: "delete_expense",
          summary: "경비 삭제",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "삭제 성공" } }
        }
      },
      "/api/upload_receipt": {
        post: {
          operationId: "upload_receipt",
          summary: "영수증 이미지 업로드",
          description: "base64 인코딩된 영수증 이미지를 Google Drive에 저장합니다. 반환된 receipt_path를 save_expense에 사용하세요.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["data","filename"], properties: {
              data: { type: "string", description: "base64 인코딩된 이미지 데이터 (data:image/... 포함 가능)" },
              filename: { type: "string", description: "저장할 파일명 (예: receipt_001.jpg)" },
              folder: { type: "string", description: "저장 폴더명 (기본: 현재월 경비)" },
            }}}}
          },
          responses: { "200": { description: "업로드 성공, receipt_path 반환" } }
        }
      },
      "/api/generate_pdf_report": {
        post: {
          operationId: "generate_pdf_report",
          summary: "PDF 보고서 생성 (영수증 포함)",
          description: "월별 경비 PDF 보고서를 생성합니다. receipts_folder를 지정하면 Google Drive reports/ 하위 해당 폴더의 모든 이미지가 PDF에 포함됩니다.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["year","month"], properties: {
            year: { type: "integer", description: "연도" },
            month: { type: "integer", description: "월" },
            project: { type: "string", description: "프로젝트명 (선택)" },
            receipts_folder: { type: "string", description: "영수증 폴더명 (reports/ 하위. 예: '2월 영수증')" },
          }}}}},
          responses: { "200": { description: "보고서 생성 완료" } }
        }
      },
      "/api/generate_excel_report": {
        post: {
          operationId: "generate_excel_report",
          summary: "Excel 보고서 생성",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["year","month"], properties: {
            year: { type: "integer" }, month: { type: "integer" }, project: { type: "string" }
          }}}}},
          responses: { "200": { description: "보고서 생성 완료" } }
        }
      }
    }
  });
});

// 로컬 실행 시에만 서버 시작 (Vercel은 export default app 사용)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 8787;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Expense MCP Server running → http://0.0.0.0:${PORT}/mcp`);
    console.log(`✅ ChatGPT Enterprise 연결 준비 완료`);
  });
}

export default app;
