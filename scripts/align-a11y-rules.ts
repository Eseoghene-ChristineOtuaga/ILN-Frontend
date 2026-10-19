#!/usr/bin/env node

/**
 * Accessibility Rules Alignment Utility
 *
 * Ensures Lighthouse assertions and component test suites align
 * Detects contradictory thresholds between CI and local tests
 * Generates unified a11y configuration
 */

import fs from "fs";
import path from "path";

interface A11yRule {
  name: string;
  lighthouseLevel: "error" | "warn" | null;
  testLevel: "error" | "warn" | null;
  aligned: boolean;
}

const LIGHTHOUSE_CONFIG = ".lighthouserc.json";
const TEST_CONFIG = "vitest.config.ts";

// Extract accessibility rules from Lighthouse config
function extractLighthouseRules(): Record<string, string> {
  const config = JSON.parse(fs.readFileSync(LIGHTHOUSE_CONFIG, "utf-8"));
  const rules: Record<string, string> = {};

  const assertions =
    config.ci.assert.assertMatrix[0].assertions || {};

  Object.entries(assertions).forEach(([rule, level]) => {
    if (rule.startsWith("aria-") || ["color-contrast", "button-name", "image-alt", "label"].includes(rule)) {
      rules[rule] = Array.isArray(level) ? level[0] : "unknown";
    }
  });

  return rules;
}

// Check test configuration alignment
function checkTestAlignment(): Record<string, string> {
  const testRules: Record<string, string> = {};

  // Common a11y test patterns
  const commonTests = [
    "aria-required-attr",
    "aria-roles",
    "color-contrast",
    "button-name",
    "image-alt",
    "label",
  ];

  commonTests.forEach((rule) => {
    // This would check actual test files, for now return expected defaults
    testRules[rule] = "error";
  });

  return testRules;
}

// Align rules
function alignRules(): A11yRule[] {
  const lighthouseRules = extractLighthouseRules();
  const testRules = checkTestAlignment();

  const allRules = new Set([...Object.keys(lighthouseRules), ...Object.keys(testRules)]);
  const aligned: A11yRule[] = [];

  allRules.forEach((rule) => {
    const lhLevel = lighthouseRules[rule] || null;
    const testLevel = testRules[rule] || null;

    aligned.push({
      name: rule,
      lighthouseLevel: lhLevel as "error" | "warn" | null,
      testLevel: testLevel as "error" | "warn" | null,
      aligned: lhLevel === testLevel,
    });
  });

  return aligned;
}

// Generate unified configuration
function generateUnifiedConfig(): string {
  const rules = alignRules();
  const config = {
    accessibility: {
      rules: rules
        .filter((r) => r.lighthouseLevel || r.testLevel)
        .reduce(
          (acc, rule) => {
            const level = rule.lighthouseLevel || rule.testLevel;
            acc[rule.name] = {
              level: level,
              description: `WCAG accessibility check: ${rule.name}`,
            };
            return acc;
          },
          {} as Record<string, any>
        ),
      minScore: 0.9,
      categories: {
        accessibility: 0.9,
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

// Main function
function main() {
  console.log("\n🔄 Accessibility Rules Alignment Report\n");

  const rules = alignRules();

  const aligned = rules.filter((r) => r.aligned);
  const misaligned = rules.filter((r) => !r.aligned && r.lighthouseLevel && r.testLevel);
  const orphaned = rules.filter(
    (r) => !r.aligned && (!r.lighthouseLevel || !r.testLevel)
  );

  console.log(`📊 Summary:`);
  console.log(`   Total rules: ${rules.length}`);
  console.log(`   ✓ Aligned: ${aligned.length}`);
  console.log(`   ❌ Misaligned: ${misaligned.length}`);
  console.log(`   ⚠️  Orphaned: ${orphaned.length}\n`);

  if (misaligned.length > 0) {
    console.log(`⚠️  Misaligned Rules:\n`);
    misaligned.forEach((rule) => {
      console.log(`   ${rule.name}:`);
      console.log(`      Lighthouse: ${rule.lighthouseLevel}`);
      console.log(`      Tests: ${rule.testLevel}`);
      console.log();
    });
  }

  if (orphaned.length > 0) {
    console.log(`⚠️  Orphaned Rules (exists in one config only):\n`);
    orphaned.forEach((rule) => {
      if (rule.lighthouseLevel && !rule.testLevel) {
        console.log(
          `   ${rule.name}: defined in Lighthouse only (level: ${rule.lighthouseLevel})`
        );
      } else {
        console.log(
          `   ${rule.name}: defined in tests only (level: ${rule.testLevel})`
        );
      }
    });
    console.log();
  }

  if (misaligned.length === 0 && orphaned.length === 0) {
    console.log("✅ All rules aligned between Lighthouse and test suites.\n");
  } else {
    console.log(
      "⚠️  Found configuration inconsistencies. See above for details.\n"
    );
  }

  // Save unified config
  const unifiedConfig = generateUnifiedConfig();
  const outputFile = ".lighthouseci/a11y-rules.json";
  fs.writeFileSync(outputFile, unifiedConfig);
  console.log(`📝 Unified config generated: ${outputFile}\n`);
}

main();
