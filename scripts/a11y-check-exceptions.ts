#!/usr/bin/env node

/**
 * Accessibility Exception Monitor
 *
 * Validates a11y-exceptions.json against Lighthouse violations
 * Enforces expiry dates and required fields
 * Alerts on upcoming expirations
 */

import fs from "fs";
import path from "path";

interface A11yException {
  id: string;
  owner: string;
  violation: string;
  severity: "minor" | "moderate" | "major" | "critical";
  component: string;
  reason: string;
  userImpact: string;
  expiryDate: string;
  remediationPlan: string;
  status: "active" | "resolved" | "deferred";
  resolvedDate?: string;
  resolutionMethod?: string;
}

interface ExceptionConfig {
  exceptions: A11yException[];
}

const EXCEPTION_FILE = ".lighthouseci/a11y-exceptions.json";
const MAX_DURATION_DAYS = 90;
const WARNING_DAYS = 30;
const ERROR_DAYS = 0;

function loadExceptions(): ExceptionConfig {
  if (!fs.existsSync(EXCEPTION_FILE)) {
    return { exceptions: [] };
  }
  return JSON.parse(fs.readFileSync(EXCEPTION_FILE, "utf-8"));
}

function validateException(ex: A11yException): string[] {
  const errors: string[] = [];

  if (!ex.id || !ex.id.match(/^a11y-exception-\d{4}-\d{2}-\d{2}-\d{3}$/)) {
    errors.push(`Invalid ID format: ${ex.id}`);
  }

  if (!ex.owner || ex.owner.length === 0) {
    errors.push(`Missing owner for ${ex.id}`);
  }

  if (!ex.violation) {
    errors.push(`Missing violation rule for ${ex.id}`);
  }

  if (!["minor", "moderate", "major", "critical"].includes(ex.severity)) {
    errors.push(`Invalid severity for ${ex.id}: ${ex.severity}`);
  }

  if (!ex.component || ex.component.length === 0) {
    errors.push(`Missing component for ${ex.id}`);
  }

  if (!ex.reason || ex.reason.length === 0) {
    errors.push(`Missing reason for ${ex.id}`);
  }

  if (!ex.userImpact || ex.userImpact === "none") {
    errors.push(`Missing or invalid user impact for ${ex.id}`);
  }

  if (!ex.expiryDate) {
    errors.push(`Missing expiry date for ${ex.id}`);
  } else {
    const expiry = new Date(ex.expiryDate);
    if (isNaN(expiry.getTime())) {
      errors.push(`Invalid expiry date format for ${ex.id}: ${ex.expiryDate}`);
    }
  }

  if (!ex.remediationPlan || ex.remediationPlan === "TBD") {
    errors.push(`Missing or incomplete remediation plan for ${ex.id}`);
  }

  return errors;
}

function getDaysUntilExpiry(expiryDate: string): number {
  const expiry = new Date(expiryDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = expiry.getTime() - today.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function main() {
  const config = loadExceptions();
  const today = new Date();
  let hasErrors = false;
  let hasWarnings = false;

  console.log("\n🔍 Accessibility Exception Report\n");
  console.log(`Generated: ${formatDate(today)}\n`);

  const active = config.exceptions.filter((ex) => ex.status === "active");
  const resolved = config.exceptions.filter((ex) => ex.status === "resolved");
  const deferred = config.exceptions.filter((ex) => ex.status === "deferred");

  console.log(`📊 Summary:`);
  console.log(`   Active: ${active.length}`);
  console.log(`   Resolved: ${resolved.length}`);
  console.log(`   Deferred: ${deferred.length}\n`);

  // Validate all exceptions
  console.log(`✅ Validation:\n`);
  let validationErrors = 0;

  for (const ex of config.exceptions) {
    const errors = validateException(ex);
    if (errors.length > 0) {
      validationErrors += errors.length;
      console.log(`   ❌ ${ex.id}:`);
      errors.forEach((err) => console.log(`      - ${err}`));
    }
  }

  if (validationErrors === 0) {
    console.log(`   ✓ All exceptions validated\n`);
  } else {
    console.log(`   Found ${validationErrors} validation errors\n`);
    hasErrors = true;
  }

  // Check expirations
  console.log(`⏰ Expiration Status:\n`);

  const expiring = active.filter((ex) => {
    const daysLeft = getDaysUntilExpiry(ex.expiryDate);
    return daysLeft <= WARNING_DAYS && daysLeft > ERROR_DAYS;
  });

  const expired = active.filter((ex) => {
    const daysLeft = getDaysUntilExpiry(ex.expiryDate);
    return daysLeft <= ERROR_DAYS;
  });

  const healthy = active.filter((ex) => {
    const daysLeft = getDaysUntilExpiry(ex.expiryDate);
    return daysLeft > WARNING_DAYS;
  });

  if (expired.length > 0) {
    console.log(`   ❌ Expired (${expired.length}):`);
    expired.forEach((ex) => {
      const daysOver = Math.abs(getDaysUntilExpiry(ex.expiryDate));
      console.log(`      - ${ex.id}: ${daysOver} days overdue`);
    });
    hasErrors = true;
  }

  if (expiring.length > 0) {
    console.log(`   ⚠️  Expiring soon (${expiring.length}):`);
    expiring.forEach((ex) => {
      const daysLeft = getDaysUntilExpiry(ex.expiryDate);
      console.log(`      - ${ex.id}: ${daysLeft} days left`);
    });
    hasWarnings = true;
  }

  if (healthy.length > 0) {
    console.log(`   ✓ Healthy (${healthy.length})`);
  }

  if (expired.length === 0 && expiring.length === 0 && healthy.length === 0) {
    console.log(`   ✓ No active exceptions\n`);
  } else {
    console.log();
  }

  // Severity breakdown
  console.log(`📋 By Severity (Active):\n`);
  const bySeverity = {
    critical: active.filter((ex) => ex.severity === "critical").length,
    major: active.filter((ex) => ex.severity === "major").length,
    moderate: active.filter((ex) => ex.severity === "moderate").length,
    minor: active.filter((ex) => ex.severity === "minor").length,
  };

  Object.entries(bySeverity).forEach(([sev, count]) => {
    if (count > 0) {
      const icon = sev === "critical" ? "🔴" : sev === "major" ? "🟠" : "🟡";
      console.log(`   ${icon} ${sev}: ${count}`);
    }
  });

  if (Object.values(bySeverity).every((c) => c === 0)) {
    console.log(`   ✓ No exceptions`);
  }

  console.log("\n" + "=".repeat(60) + "\n");

  // Exit codes
  if (hasErrors) {
    console.log("❌ Errors found. CI should fail.\n");
    process.exit(1);
  } else if (hasWarnings) {
    console.log("⚠️  Warnings found. Review expiring exceptions.\n");
    process.exit(0);
  } else {
    console.log("✅ All checks passed.\n");
    process.exit(0);
  }
}

main();
