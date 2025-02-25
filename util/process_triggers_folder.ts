import fs from 'fs';
import path from 'path';
import process from 'process';
import * as url from 'url';

import eslint from 'eslint';
import * as tsNode from 'ts-node';

import UserConfig from '../resources/user_config';
import { LooseTriggerSet } from '../types/trigger';
import defaultRaidbossOptions from '../ui/raidboss/raidboss_options';

import { walkDirAsync } from './file_utils';

const __filename = url.fileURLToPath(new URL('.', import.meta.url));
const __dirname = path.basename(__filename);
const root = path.join(__dirname, '../ui/raidboss/data/');
const distRoot = path.join(__dirname, '../dist/triggers/ui/raidboss/data/');

fs.rmSync(distRoot, { recursive: true, force: true });

// Probably we could do this more cleanly with babel, but we'll just regex for simplicitly.
const removeImports = (lines: string[]) => {
  // You can't import in a user file, so remove these lines.
  // TODO: we really should test that all imports are ones that can be used in eval.
  return lines.filter((line) => {
    if (/^export default triggerSet;/.exec(line))
      return false;
    if (/^import /.exec(line))
      return false;
    return true;
  });
};

const removeExportOnDeclarations = (lines: string[]) => {
  return lines.map((line) => {
    if (!/^export const /.exec(line))
      return line;
    return line.replace(/^export /, '');
  });
};

const removeSourceMap = (lines: string[]) => {
  return lines.filter((line) => !line.startsWith('//# sourceMappingURL'));
};

const changeExportToPush = (lines: string[]) => {
  // User files are not modules and so push onto a global Options variable rather than
  // exporting, so modify these files so that they can be used directly as user files.
  const exportRegex = /^(?:export default {|const triggerSet = {)\s*/;
  const closingRegex = /^};\s*$/;

  let replacedExportCount = 0;
  let replacedClosingCount = 0;
  lines = lines.map((line) => {
    if (exportRegex.exec(line)) {
      replacedExportCount++;
      line = line.replace(exportRegex, 'Options.Triggers.push({');
    }
    // Function definitions that match closingRegex can happen before the export line.
    if (replacedExportCount && closingRegex.exec(line)) {
      replacedClosingCount++;
      line = line.replace(closingRegex, '});');
    }
    return line;
  });

  if (replacedExportCount !== 1 || replacedClosingCount !== 1) {
    console.error(
      `Found ${replacedExportCount} export lines and ${replacedClosingCount} closing lines, aborting.`,
    );
    process.exit(3);
  }

  return lines;
};

const lint = async (filename: string, lines: string[]) => {
  const dprintLinter = new eslint.ESLint({ fix: true });

  const config = JSON.parse(
    JSON.stringify(await dprintLinter.calculateConfigForFile(filename)),
  ) as eslint.Linter.Config<eslint.Linter.RulesRecord>;
  config.plugins = config.plugins?.filter((p) => p !== 'dprint');
  delete config?.rules?.['dprint/dprint'];

  // Run without dprint first, because dprint is slow on unformatted files.
  const linter = new eslint.ESLint({
    fix: true,
    useEslintrc: false,
    baseConfig: config,
  });
  const contents = lines.join('\n');
  const eslintResults = await linter.lintText(contents, { filePath: filename });
  const eslintLintResult = eslintResults[0];
  if (
    eslintLintResult === undefined ||
    eslintLintResult.output === undefined ||
    eslintLintResult.output.length === 0 ||
    eslintLintResult.errorCount > 0
  ) {
    console.error('Lint (eslint) ran with errors, aborting.');
    return eslintLintResult;
  }

  // Run again with dprint to get a finalized version.
  const results = await dprintLinter.lintText(eslintLintResult.output, { filePath: filename });
  const lintResult = results[0];
  // If dprint didn't have anything to change, the output is undefined, so return the results
  // of the previous lint.
  if (lintResult?.output === undefined || lintResult?.output.length === 0)
    return eslintLintResult;

  // There's only one result from lintText, as per documentation.
  return lintResult;
};

const tsc = tsNode.create({
  transpileOnly: true,
  project: path.join(__dirname, '../tsconfig.json'),
});

const processFile = async (originalFilename: string) => {
  console.error(`Processing file: ${path.relative(path.join(__dirname, '..'), originalFilename)}`);
  const transpiledContents = tsc.compile(
    fs.readFileSync(originalFilename).toString(),
    originalFilename,
  );
  const distFilePath = path.join(distRoot, path.relative(root, originalFilename));
  let lines = transpiledContents.split(/[\r\n]+/);

  lines = removeImports(lines);
  lines = changeExportToPush(lines);
  lines = removeSourceMap(lines);
  lines = removeExportOnDeclarations(lines);
  const lintResult = await lint(originalFilename.replace('.ts', '.js'), lines);
  if (!lintResult) {
    console.error('${filename}: No result from linting?');
    process.exit(2);
  }

  const ignoreRules = [
    // ES2020 -> ES2019 rewriting of optional chaining (i.e. `?.`) turns into this.
    'no-cond-assign',
    // Often tsc will combine lines (even across existing linebreaks) violating this.
    'max-len',
  ];
  const messages = lintResult.messages.filter((message) => {
    if (message.ruleId === null)
      return true;
    return !ignoreRules.includes(message.ruleId);
  });

  // lintResult.errorCount exists, but we need a recount after ignoring some rules.
  const numErrors = messages.filter((x) => x.severity === 2).length;
  const numWarnings = messages.filter((x) => x.severity === 1).length;

  if (numErrors > 0) {
    console.error(`${originalFilename}: Lint ran with errors: ${JSON.stringify(messages)}`);
    process.exit(3);
  } else if (numWarnings > 0) {
    // Print warnings, but don't stop.
    console.error(`${originalFilename}: Lint ran with warnings: ${JSON.stringify(messages)}`);
  }

  const contents = lintResult.output;
  if (contents === undefined) {
    console.error(`${originalFilename}: Lint returned no contents`);
    process.exit(4);
  }

  // Validate that our regex search/replace created a valid user file that can be eval'd.
  try {
    const options = { ...defaultRaidbossOptions };
    UserConfig.evalUserFile(contents, options);
  } catch (e) {
    console.error(`${distFilePath}: Failed eval.`);
    console.log(e);
    process.exit(5);
  }

  // Overwrite the file.
  fs.mkdirSync(path.dirname(distFilePath), { recursive: true });
  fs.writeFileSync(distFilePath.replace('.ts', '.js'), contents);

  // Copy timeline file if present
  const importPath = ('../ui/raidboss/data/' + path.relative(root, originalFilename)).replace(
    '\\',
    '/',
  );
  // Dynamic imports don't have a type, so add type assertion.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const triggerSet = (await import(importPath)).default as LooseTriggerSet;
  const timelineFilename = triggerSet?.timelineFile;
  if (timelineFilename !== undefined) {
    const timelineFile = path.join(path.dirname(originalFilename), timelineFilename);
    if (fs.existsSync(timelineFile)) {
      const destination = path.join(path.dirname(distFilePath), timelineFilename);
      fs.copyFileSync(timelineFile, destination);
    }
  }
};

const processAllFiles = async (root: string) => {
  // Process files.
  await walkDirAsync(root, async (filename) => {
    if (filename.endsWith('.js') || filename.endsWith('.ts'))
      await processFile(filename);
  });
  process.exit(0);
};

void processAllFiles(root);
