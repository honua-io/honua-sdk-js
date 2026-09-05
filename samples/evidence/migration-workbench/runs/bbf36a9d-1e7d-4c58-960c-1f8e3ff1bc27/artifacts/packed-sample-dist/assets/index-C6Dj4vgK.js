const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./migrated-main-COjStP6r.js","./preload-helper-CW7Fztz1.js","./errors-mQtjOroP.js"])))=>i.map(i=>d[i]);
import { t as __vitePreload } from "./preload-helper-CW7Fztz1.js";
//#region \0vite/modulepreload-polyfill.js
(function polyfill() {
	const relList = document.createElement("link").relList;
	if (relList && relList.supports && relList.supports("modulepreload")) return;
	for (const link of document.querySelectorAll("link[rel=\"modulepreload\"]")) processPreload(link);
	new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") continue;
			for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
		}
	}).observe(document, {
		childList: true,
		subtree: true
	});
	function getFetchOpts(link) {
		const fetchOpts = {};
		if (link.integrity) fetchOpts.integrity = link.integrity;
		if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
		if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
		else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
		else fetchOpts.credentials = "same-origin";
		return fetchOpts;
	}
	function processPreload(link) {
		if (link.ep) return;
		link.ep = true;
		const fetchOpts = getFetchOpts(link);
		fetch(link.href, fetchOpts);
	}
})();
//#endregion
//#region examples/_kit/cleanup.ts
var SampleCleanupRegistry = class {
	#cleanups = [];
	#state = "open";
	#disposePromise;
	get disposed() {
		return this.#state === "disposed";
	}
	add(cleanup) {
		if (this.#state === "disposed") throw new Error("cannot register cleanup after disposal completed");
		this.#cleanups.push(cleanup);
		return cleanup;
	}
	resource(resource) {
		if ("unsubscribe" in resource) this.add(() => resource.unsubscribe());
		else if ("terminate" in resource) this.add(() => resource.terminate());
		else if ("dispose" in resource) this.add(() => resource.dispose());
		else if ("remove" in resource) this.add(() => resource.remove());
		else this.add(() => resource.close());
	}
	listen(target, type, listener, options) {
		target.addEventListener(type, listener, options);
		try {
			this.add(() => target.removeEventListener(type, listener, options));
		} catch (error) {
			target.removeEventListener(type, listener, options);
			throw error;
		}
	}
	timeout(callback, milliseconds) {
		const handle = window.setTimeout(callback, milliseconds);
		try {
			this.add(() => window.clearTimeout(handle));
		} catch (error) {
			window.clearTimeout(handle);
			throw error;
		}
		return handle;
	}
	interval(callback, milliseconds) {
		const handle = window.setInterval(callback, milliseconds);
		try {
			this.add(() => window.clearInterval(handle));
		} catch (error) {
			window.clearInterval(handle);
			throw error;
		}
		return handle;
	}
	dispose() {
		if (this.#disposePromise) return this.#disposePromise;
		this.#state = "disposing";
		this.#disposePromise = (async () => {
			const failures = [];
			while (this.#cleanups.length > 0) {
				for (const cleanup of this.#cleanups.splice(0).reverse()) try {
					await cleanup();
				} catch (error) {
					failures.push(error);
				}
				await Promise.resolve();
			}
			this.#state = "disposed";
			if (failures.length > 0) throw new AggregateError(failures, "sample cleanup failed");
		})();
		return this.#disposePromise;
	}
};
//#endregion
//#region examples/_kit/presentation.ts
var SAMPLE_TEST_IDS = Object.freeze({
	modeBadge: "honua-sample-mode",
	evidenceDrawer: "honua-sample-evidence",
	degradationPanel: "honua-sample-degradation",
	errorPanel: "honua-sample-error",
	disposeButton: "honua-sample-dispose"
});
function text(value) {
	return value instanceof Error ? value.message : String(value);
}
function announceSampleStatus(message, root = document) {
	const region = root.querySelector("[data-honua-sample-announcer]");
	if (region) region.textContent = message;
}
function mountSamplePresentation(options) {
	const sdkMode = "packed";
	const root = document.createElement("aside");
	root.className = "honua-sample-kit";
	root.dataset.sampleId = options.sampleId;
	root.setAttribute("aria-label", "Demo diagnostics");
	const mode = document.createElement("span");
	mode.className = "honua-sample-kit__mode";
	mode.dataset.testid = SAMPLE_TEST_IDS.modeBadge;
	mode.dataset.sdkMode = sdkMode;
	mode.textContent = `${sdkMode} SDK`;
	const evidence = document.createElement("details");
	evidence.dataset.testid = SAMPLE_TEST_IDS.evidenceDrawer;
	const evidenceSummary = document.createElement("summary");
	evidenceSummary.textContent = "Evidence";
	const evidenceList = document.createElement("dl");
	const updateEvidence = (entries) => {
		evidenceList.replaceChildren();
		for (const [label, value] of Object.entries(entries)) {
			const term = document.createElement("dt");
			term.textContent = label;
			const detail = document.createElement("dd");
			detail.textContent = value;
			evidenceList.append(term, detail);
		}
	};
	updateEvidence(options.evidence);
	evidence.append(evidenceSummary, evidenceList);
	const degradation = document.createElement("p");
	degradation.dataset.testid = SAMPLE_TEST_IDS.degradationPanel;
	degradation.setAttribute("role", "status");
	degradation.hidden = true;
	const error = document.createElement("p");
	error.dataset.testid = SAMPLE_TEST_IDS.errorPanel;
	error.setAttribute("role", "alert");
	error.hidden = true;
	const announcer = document.createElement("span");
	announcer.className = "honua-sample-kit__sr-only";
	announcer.dataset.honuaSampleAnnouncer = "true";
	announcer.setAttribute("aria-live", "polite");
	root.append(mode, evidence, degradation, error, announcer);
	if (options.onDispose) {
		const dispose = document.createElement("button");
		dispose.type = "button";
		dispose.dataset.testid = SAMPLE_TEST_IDS.disposeButton;
		dispose.textContent = "Dispose demo";
		let disposing = false;
		dispose.addEventListener("click", async () => {
			if (disposing) return;
			disposing = true;
			dispose.disabled = true;
			try {
				await options.onDispose?.();
			} catch (value) {
				error.textContent = text(value);
				error.hidden = false;
				announceSampleStatus(`Demo cleanup error: ${error.textContent}`, root);
			}
		});
		root.append(dispose);
	}
	document.body.prepend(root);
	return {
		root,
		updateEvidence,
		showError(value) {
			error.textContent = text(value);
			error.hidden = false;
			announceSampleStatus(`Demo error: ${error.textContent}`, root);
		},
		showDegradation(reasons) {
			degradation.textContent = reasons.join(" · ");
			degradation.hidden = reasons.length === 0;
			if (reasons.length > 0) announceSampleStatus(`Demo degradation: ${degradation.textContent}`, root);
		},
		clearStatus() {
			degradation.hidden = true;
			degradation.textContent = "";
			error.hidden = true;
			error.textContent = "";
		}
	};
}
//#endregion
//#region examples/migration-workbench/src/artifacts.ts
var ARTIFACT_FILENAMES = {
	manifest: "manifest.v1.json",
	migrationReport: "migration-report.v1.json",
	widgetReadiness: "widget-readiness.v1.json",
	maplibreAssessment: "maplibre-assessment.v1.json",
	diff: "migration.v1.patch"
};
async function loadMigrationWorkbenchArtifacts(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
	const artifactBaseUrl = (options.artifactBaseUrl ?? "./artifacts/v1").replace(/\/$/u, "");
	const [manifest, migrationReport, widgetReadiness, maplibreAssessment, diff] = await Promise.all([
		fetchJson(fetchFn, `${artifactBaseUrl}/${ARTIFACT_FILENAMES.manifest}`, options.signal),
		fetchJson(fetchFn, `${artifactBaseUrl}/${ARTIFACT_FILENAMES.migrationReport}`, options.signal),
		fetchJson(fetchFn, `${artifactBaseUrl}/${ARTIFACT_FILENAMES.widgetReadiness}`, options.signal),
		fetchJson(fetchFn, `${artifactBaseUrl}/${ARTIFACT_FILENAMES.maplibreAssessment}`, options.signal),
		fetchText(fetchFn, `${artifactBaseUrl}/${ARTIFACT_FILENAMES.diff}`, options.signal)
	]);
	return {
		manifest: parseManifest(manifest),
		migrationReport: parseMigrationReport(migrationReport),
		widgetReadiness: parseWidgetReadiness(widgetReadiness),
		maplibreAssessment: parseMapLibreAssessment(maplibreAssessment),
		diff
	};
}
function parseManifest(value) {
	const record = requireRecord(value, "manifest");
	requireSchema(record, "honua.migration-workbench.manifest.v1", "manifest");
	requireString(record.artifactSet, "manifest.artifactSet");
	requireString(record.fixture, "manifest.fixture");
	requireArray(record.commands, "manifest.commands");
	requireArray(record.files, "manifest.files");
	requireRecord(record.provenance, "manifest.provenance");
	return record;
}
function parseMigrationReport(value) {
	const record = requireRecord(value, "migration report");
	requireSchema(record, "honua.migration-workbench.report.v1", "migration report");
	const migration = requireRecord(requireRecord(record.demo, "migration report.demo").migration, "migration report.demo.migration");
	requireRecord(migration.scanReport, "migration report.demo.migration.scanReport");
	requireRecord(migration.codemodResult, "migration report.demo.migration.codemodResult");
	requireArray(migration.gates, "migration report.demo.migration.gates");
	requireArray(requireRecord(record.behaviorProof, "migration report.behaviorProof").assertions, "migration report.behaviorProof.assertions");
	requireRecord(record.patchProof, "migration report.patchProof");
	return record;
}
function parseWidgetReadiness(value) {
	const record = requireRecord(value, "widget readiness");
	requireSchema(record, "honua.migration-workbench.widget-readiness.v1", "widget readiness");
	const report = requireRecord(record.report, "widget readiness.report");
	requireArray(report.widgets, "widget readiness.report.widgets");
	requireRecord(report.summary, "widget readiness.report.summary");
	return record;
}
function parseMapLibreAssessment(value) {
	const record = requireRecord(value, "MapLibre assessment");
	requireSchema(record, "honua.migration-workbench.maplibre-assessment.v1", "MapLibre assessment");
	const report = requireRecord(record.report, "MapLibre assessment.report");
	requireRecord(report.codemodResult, "MapLibre assessment.report.codemodResult");
	requireArray(report.gates, "MapLibre assessment.report.gates");
	const residuals = requireRecord(record.residuals, "MapLibre assessment.residuals");
	requireArray(residuals.manualTodos, "MapLibre assessment.residuals.manualTodos");
	requireArray(residuals.unsupportedModules, "MapLibre assessment.residuals.unsupportedModules");
	return record;
}
async function fetchJson(fetchFn, url, signal) {
	const response = await fetchFn(url, {
		method: "GET",
		credentials: "omit",
		signal
	});
	if (!response.ok) throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
	return response.json();
}
async function fetchText(fetchFn, url, signal) {
	const response = await fetchFn(url, {
		method: "GET",
		credentials: "omit",
		signal
	});
	if (!response.ok) throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
	return response.text();
}
function requireSchema(record, expected, label) {
	if (record.schemaVersion !== expected) throw new Error(`${label} has unsupported schemaVersion ${String(record.schemaVersion)}`);
}
function requireRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value;
}
function requireArray(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}
function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
//#endregion
//#region examples/migration-workbench/src/workflow.ts
function createAssertionMatrix(assertions, browserObservations) {
	return assertions.map((assertion) => {
		const browserObserved = readJsonPath(browserObservations, assertion.path);
		return {
			...assertion,
			browserObserved,
			browserPassed: browserObserved !== void 0 && jsonValuesEqual(assertion.expected, browserObserved)
		};
	});
}
function readJsonPath(value, path) {
	if (!path.startsWith("$")) return void 0;
	let current = value;
	let cursor = 1;
	for (const match of path.matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/gu)) {
		if (match.index !== cursor) return void 0;
		cursor = match.index + match[0].length;
		if (match[1] !== void 0) {
			if (!current || typeof current !== "object" || Array.isArray(current)) return void 0;
			current = current[match[1]];
		} else {
			if (!Array.isArray(current)) return void 0;
			current = current[Number(match[2])];
		}
	}
	if (cursor !== path.length || !isJsonValue(current)) return void 0;
	return current;
}
function jsonValuesEqual(left, right) {
	if (left === right) return true;
	if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonValuesEqual(item, right[index]));
	if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(right)) {
		const leftEntries = Object.entries(left);
		const rightRecord = right;
		return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, item]) => key in rightRecord && jsonValuesEqual(item, rightRecord[key]));
	}
	return false;
}
function isJsonValue(value) {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	return Boolean(value) && typeof value === "object" && Object.values(value).every(isJsonValue);
}
//#endregion
//#region examples/migration-workbench/src/model.ts
var PUBLIC_ARTIFACT_PREFIX = "examples/migration-workbench/public/";
var GENERATED_TARGET_PATH = "examples/migration-workbench/src/generated/migrated-main.js";
var GENERATED_TARGET_HREF = "./artifacts/v1/migrated-main.js";
function createMigrationWorkbenchViewModel(artifacts, browserObservations) {
	assertArtifactSetCoherence(artifacts);
	const compatibility = artifacts.migrationReport.demo.migration;
	const maplibre = artifacts.maplibreAssessment.report;
	const assertions = createAssertionMatrix(artifacts.migrationReport.behaviorProof.assertions, browserObservations);
	return {
		fixture: artifacts.manifest.fixture,
		target: artifacts.migrationReport.target,
		artifactSet: artifacts.manifest.artifactSet,
		generatedAt: artifacts.migrationReport.demo.generatedAt,
		source: {
			path: artifacts.manifest.provenance.fixture,
			authorship: artifacts.manifest.provenance.authorship,
			licenseScope: artifacts.manifest.provenance.licenseScope,
			sourceUpload: artifacts.manifest.provenance.sourceUpload,
			credentialsRequired: artifacts.manifest.provenance.credentialsRequired
		},
		compatibility: {
			readiness: compatibility.readiness,
			passed: artifacts.migrationReport.demo.passed,
			metrics: migrationMetrics(compatibility),
			gates: compatibility.gates,
			mappings: mappingRows(compatibility.codemodResult.metrics.byKind),
			manualTodos: compatibility.manualTodos,
			unsupportedModules: compatibility.unhandledArcGisModules
		},
		widgets: artifacts.widgetReadiness.report,
		maplibre: {
			readiness: maplibre.readiness,
			metrics: migrationMetrics(maplibre),
			gates: maplibre.gates,
			mappings: mappingRows(maplibre.codemodResult.metrics.byKind),
			manualTodos: artifacts.maplibreAssessment.residuals.manualTodos,
			unsupportedModules: artifacts.maplibreAssessment.residuals.unsupportedModules
		},
		assertions,
		browserProofPassed: artifacts.migrationReport.behaviorProof.passed && assertions.length > 0 && assertions.every((assertion) => assertion.passed && assertion.browserPassed),
		patchProof: artifacts.migrationReport.patchProof,
		commands: artifacts.manifest.commands,
		files: artifacts.manifest.files.map((file) => ({
			...file,
			href: publicHref(file)
		})),
		diff: artifacts.diff,
		provenance: artifacts.manifest.provenance
	};
}
function formatArtifactCommand(executable, argv) {
	return [executable, ...argv].map((part) => JSON.stringify(part)).join(" ");
}
function migrationMetrics(migration) {
	const metrics = migration.codemodResult.metrics;
	return [
		{
			id: "files-scanned",
			label: "Files scanned",
			value: migration.scanReport.filesScanned,
			tone: "neutral",
			scope: "CLI scan report"
		},
		{
			id: "auto-migrated",
			label: "Auto migrated",
			value: metrics.autoMigratedCallSites,
			tone: "good",
			scope: "Codemod-scoped call sites"
		},
		{
			id: "manual-call-sites",
			label: "Manual call sites",
			value: metrics.manualCallSites,
			tone: metrics.manualCallSites === 0 ? "good" : "warning",
			scope: "Codemod-scoped call sites"
		},
		{
			id: "unsupported-modules",
			label: "Unsupported modules",
			value: migration.unhandledArcGisModules.length,
			tone: migration.unhandledArcGisModules.length === 0 ? "good" : "danger",
			scope: "Discovered ArcGIS modules outside codemod scope"
		},
		{
			id: "blocking-flags",
			label: "Blocking scan flags",
			value: migration.scanReport.flags.length,
			tone: migration.scanReport.flags.length === 0 ? "good" : "danger",
			scope: "CLI scan flags"
		}
	];
}
function mappingRows(byKind) {
	return Object.entries(byKind).map(([kind, metric]) => ({
		kind,
		...metric
	})).sort((left, right) => left.kind.localeCompare(right.kind));
}
function publicHref(file) {
	if (file.repositoryPath === GENERATED_TARGET_PATH) return GENERATED_TARGET_HREF;
	if (!file.repositoryPath.startsWith(PUBLIC_ARTIFACT_PREFIX)) return void 0;
	return `./${file.repositoryPath.slice(36)}`;
}
function assertArtifactSetCoherence(artifacts) {
	const fixtures = [
		artifacts.manifest.fixture,
		artifacts.migrationReport.fixture,
		artifacts.widgetReadiness.fixture,
		artifacts.maplibreAssessment.fixture
	];
	if (new Set(fixtures).size !== 1) throw new Error(`Migration workbench artifact fixture mismatch: ${fixtures.join(", ")}`);
	if (artifacts.migrationReport.demo.codemodTarget !== artifacts.migrationReport.target) throw new Error("Migration report target does not match its CLI demo target");
	const manifestPaths = new Set(artifacts.manifest.files.map((file) => file.repositoryPath));
	for (const path of [
		"examples/migration-workbench/public/artifacts/v1/migration-report.v1.json",
		"examples/migration-workbench/public/artifacts/v1/widget-readiness.v1.json",
		"examples/migration-workbench/public/artifacts/v1/maplibre-assessment.v1.json",
		"examples/migration-workbench/public/artifacts/v1/migration.v1.patch",
		"examples/migration-workbench/src/generated/migrated-main.js"
	]) if (!manifestPaths.has(path)) throw new Error(`Migration workbench manifest is missing ${path}`);
}
//#endregion
//#region examples/migration-workbench/src/main.ts
var cleanup = new SampleCleanupRegistry();
var bootstrapController = new AbortController();
cleanup.add(() => bootstrapController.abort());
var runtime = {
	ready: false,
	disposed: false,
	sdkMode: "packed",
	sdkVersion: "0.1.9-beta.0",
	dispose
};
var presentation = mountSamplePresentation({
	sampleId: "migration-workbench",
	evidence: {
		mode: "committed artifact replay",
		fixture: "arcgis-source-app",
		artifacts: "manifest-bound SHA-256 evidence",
		network: "loopback fixture only"
	},
	onDispose: dispose
});
cleanup.add(() => presentation.root.remove());
cleanup.listen(window, "beforeunload", () => void dispose(), { once: true });
window.__HONUA_MIGRATION_WORKBENCH__ = runtime;
window.__HONUA_MIGRATION_WORKBENCH_DISPOSE__ = dispose;
cleanup.add(() => {
	delete window.__HONUA_MIGRATION_WORKBENCH_DISPOSE__;
});
setupThemeToggle();
setupReportIndex();
bootstrap();
var THEME_SEQUENCE = [
	"auto",
	"light",
	"dark"
];
function setupThemeToggle() {
	const toggle = getElement("#theme-toggle");
	let preference = "auto";
	const apply = () => {
		if (preference === "auto") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = preference;
		toggle.textContent = `Theme: ${preference}`;
	};
	cleanup.listen(toggle, "click", () => {
		preference = THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(preference) + 1) % THEME_SEQUENCE.length] ?? "auto";
		apply();
	});
	cleanup.add(() => {
		delete document.documentElement.dataset.theme;
	});
	apply();
}
function setupReportIndex() {
	const links = [...document.querySelectorAll("#report-index-list a[href^='#']")];
	const sections = links.map((link) => document.getElementById(link.hash.slice(1))).filter((section) => section !== null);
	if (links.length === 0 || sections.length !== links.length) return;
	const setCurrent = (id) => {
		for (const link of links) if (link.hash === `#${id}`) link.setAttribute("aria-current", "true");
		else link.removeAttribute("aria-current");
	};
	const observer = new IntersectionObserver((entries) => {
		const first = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
		if (first) setCurrent(first.target.id);
	}, { rootMargin: "-15% 0px -65% 0px" });
	for (const section of sections) observer.observe(section);
	cleanup.add(() => observer.disconnect());
}
async function dispose() {
	bootstrapController.abort();
	await cleanup.dispose();
	runtime.ready = false;
	runtime.disposed = true;
	runtime.model = void 0;
}
async function bootstrap() {
	try {
		const [artifacts, generatedTarget] = await Promise.all([loadMigrationWorkbenchArtifacts({ signal: bootstrapController.signal }), __vitePreload(() => import("./migrated-main-COjStP6r.js"), __vite__mapDeps([0,1,2]), import.meta.url)]);
		bootstrapController.signal.throwIfAborted();
		const model = createMigrationWorkbenchViewModel(artifacts, generatedTarget.default);
		render(model);
		runtime.model = model;
		runtime.ready = true;
		presentation.updateEvidence({
			mode: `${runtime.sdkMode} SDK ${runtime.sdkVersion}`,
			fixture: model.fixture,
			artifacts: `${model.artifactSet} · ${model.files.length} manifest-bound files · ${model.assertions.length} browser assertions`,
			network: model.source.credentialsRequired ? "credentials declared" : "credential-free loopback replay"
		});
	} catch (error) {
		if (bootstrapController.signal.aborted) return;
		const message = error instanceof Error ? error.message : String(error);
		const errorPanel = getElement("#load-error");
		errorPanel.hidden = false;
		errorPanel.textContent = `Migration evidence could not be loaded: ${message}`;
		setText("#runtime-status", "Failed");
		getElement("#runtime-status").dataset.status = "failed";
		runtime.error = message;
		presentation.showError(error);
	}
}
function render(model) {
	setText("#fixture-name", model.fixture);
	setText("#target-name", model.target);
	setText("#artifact-set", model.artifactSet);
	const browserAssertionsPassed = model.assertions.filter((assertion) => assertion.passed && assertion.browserPassed).length;
	setText("#runtime-status", model.browserProofPassed ? `${browserAssertionsPassed} / ${model.assertions.length} passed` : `${browserAssertionsPassed} / ${model.assertions.length} passed — review mismatches`);
	getElement("#runtime-status").dataset.status = model.browserProofPassed ? "passed" : "failed";
	renderSource(model);
	renderCompatibility(model);
	renderAssertions(model);
	renderWidgets(model);
	renderMapLibre(model);
	renderCommands(model);
	renderArtifacts(model);
	renderDiff(model.diff);
}
function renderDiff(diff) {
	getElement("#migration-diff").innerHTML = diff.split("\n").map((line) => `<span class="diff-line" data-diff="${diffLineKind(line)}">${escapeHtml(line)}\n</span>`).join("");
}
function diffLineKind(line) {
	if (line.startsWith("+++") || line.startsWith("---")) return "file";
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
	return "ctx";
}
function renderSource(model) {
	getElement("#source-facts").innerHTML = [
		fact("Repository fixture", model.source.path),
		fact("Authorship", model.source.authorship),
		fact("License scope", model.source.licenseScope),
		fact("Source upload", model.source.sourceUpload ? "Yes" : "No"),
		fact("Credentials required", model.source.credentialsRequired ? "Yes" : "No"),
		fact("Generated", model.generatedAt)
	].join("");
}
function renderCompatibility(model) {
	setText("#compat-readiness", model.compatibility.readiness);
	getElement("#compat-readiness").dataset.status = model.compatibility.passed ? "passed" : "failed";
	renderMetrics("#compat-metrics", model.compatibility.metrics);
	renderGates("#compat-gates", model.compatibility.gates);
	renderResiduals("#compat-residuals", model.compatibility.manualTodos, model.compatibility.unsupportedModules);
	renderMappings("#compat-mappings", model.compatibility.mappings);
}
function renderAssertions(model) {
	const passed = model.assertions.filter((assertion) => assertion.passed && assertion.browserPassed).length;
	setText("#assertion-summary", `${passed} / ${model.assertions.length} browser checks passed`);
	getElement("#assertion-summary").dataset.status = model.browserProofPassed ? "passed" : "failed";
	getElement("#assertion-matrix").innerHTML = `
    <table>
      <thead><tr><th scope="col">Assertion</th><th scope="col">Expected</th><th scope="col">Stored run</th><th scope="col">Stored status</th><th scope="col">Browser run</th><th scope="col">Browser status</th></tr></thead>
      <tbody>${model.assertions.map((assertion) => `<tr>
            <th scope="row"><code>${escapeHtml(assertion.path)}</code></th>
            <td><code>${escapeHtml(formatJson(assertion.expected))}</code></td>
            <td><code>${escapeHtml(formatJson(assertion.observed))}</code></td>
            <td><span class="row-status" data-status="${assertion.passed ? "passed" : "failed"}">${assertion.passed ? "Pass" : "Fail"}</span></td>
            <td><code>${escapeHtml(formatJson(assertion.browserObserved))}</code></td>
            <td><span class="row-status" data-status="${assertion.browserPassed ? "passed" : "failed"}">${assertion.browserPassed ? "Pass" : "Fail"}</span></td>
          </tr>`).join("")}</tbody>
    </table>`;
}
function renderWidgets(model) {
	const summary = model.widgets.summary;
	renderMetrics("#widget-metrics", [
		metric("widget-total", "Usage sites", summary.totalSites, "neutral", "Widget CLI report"),
		metric("widget-automated", "Automated", summary.automatedSites, "good", "Widget usage sites"),
		metric("widget-assisted", "Assisted", summary.assistedSites, "warning", "Widget usage sites"),
		metric("widget-manual", "Manual", summary.manualSites, summary.manualSites === 0 ? "good" : "danger", "Widget usage sites")
	]);
	setText("#widget-summary", model.widgets.summaryLine);
	getElement("#widget-guidance").innerHTML = `
    <table>
      <thead><tr><th scope="col">Widget</th><th scope="col">Bucket</th><th scope="col">Disposition</th><th scope="col">Target</th><th scope="col">Sites</th><th scope="col">Guidance</th></tr></thead>
      <tbody>${model.widgets.widgets.map((widget) => `<tr>
            <th scope="row">${escapeHtml(widget.widget)}</th>
            <td><span class="row-status" data-status="${escapeHtml(widget.bucket)}">${escapeHtml(widget.bucket)}</span></td>
            <td>${escapeHtml(widget.disposition)}</td>
            <td><code>${escapeHtml(widget.target)}</code></td>
            <td>${widget.count}</td>
            <td><a href="${escapeHtml(guideHref(widget.guideLink))}">${escapeHtml(widget.guideLink)}</a></td>
          </tr>`).join("")}</tbody>
    </table>`;
}
function renderMapLibre(model) {
	setText("#maplibre-readiness", model.maplibre.readiness);
	getElement("#maplibre-readiness").dataset.status = model.maplibre.manualTodos.length === 0 && model.maplibre.unsupportedModules.length === 0 ? "passed" : "warning";
	renderMetrics("#maplibre-metrics", model.maplibre.metrics);
	renderGates("#maplibre-gates", model.maplibre.gates);
	renderResiduals("#maplibre-residuals", model.maplibre.manualTodos, model.maplibre.unsupportedModules);
	renderMappings("#maplibre-mappings", model.maplibre.mappings);
}
function renderCommands(model) {
	getElement("#command-list").innerHTML = model.commands.map((command) => `<article class="command-card">
        <div class="command-head"><strong>${escapeHtml(command.id)}</strong><span class="row-status" data-status="${command.exitCode === 0 ? "passed" : "failed"}">exit ${command.exitCode}</span></div>
        <pre tabindex="0">${escapeHtml(formatArtifactCommand(command.executable, command.argv))}</pre>
      </article>`).join("");
}
function renderArtifacts(model) {
	getElement("#artifact-files").innerHTML = `
    <table>
      <thead><tr><th scope="col">Artifact</th><th scope="col">Media type</th><th scope="col">Bytes</th><th scope="col">SHA-256</th></tr></thead>
      <tbody>${model.files.map((file) => `<tr>
            <th scope="row">${file.href ? `<a href="${escapeHtml(file.href)}">${escapeHtml(file.repositoryPath)}</a>` : `${escapeHtml(file.repositoryPath)} <small>(bundled runtime module)</small>`}</th>
            <td>${escapeHtml(file.mediaType)}</td>
            <td>${file.bytes.toLocaleString("en-US")}</td>
            <td><code class="hash">${escapeHtml(file.sha256)}</code></td>
          </tr>`).join("")}</tbody>
    </table>`;
	getElement("#patch-proof").innerHTML = [
		fact("Apply check", passFail(model.patchProof.applyCheckPassed)),
		fact("Applied tree equals target", passFail(model.patchProof.targetTreeEqual)),
		fact("Generated entry exact", passFail(model.patchProof.directEntryComparisonPassed)),
		fact("Target tree SHA-256", model.patchProof.targetTreeSha256)
	].join("");
}
function renderMetrics(selector, metrics) {
	getElement(selector).innerHTML = metrics.map((item) => `<article class="metric-card" data-metric-id="${escapeHtml(item.id)}" data-tone="${item.tone}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value)}</strong>
        <small>${escapeHtml(item.scope)}</small>
      </article>`).join("");
}
function renderGates(selector, gates) {
	getElement(selector).innerHTML = gates.map((gate) => `<article class="evidence-row">
        <span class="row-status" data-status="${gate.passed ? "passed" : "failed"}">${gate.passed ? "Pass" : "Not passed"}</span>
        <div><strong>${escapeHtml(gate.gate)}</strong><p>${escapeHtml(gate.detail)}</p></div>
      </article>`).join("");
}
function renderResiduals(selector, manualTodos, unsupportedModules) {
	const rows = [
		`<article class="evidence-row zero-row"><span class="count-badge">${manualTodos.length}</span><div><strong>Manual findings</strong><p>${manualTodos.length === 0 ? "None reported by the CLI." : "Every manual finding is listed below."}</p></div></article>`,
		...manualTodos.map((todo) => `<article class="evidence-row">
        <span class="row-status" data-status="warning">${escapeHtml(todo.difficulty)}</span>
        <div><strong>${escapeHtml(todo.kind)} · ${escapeHtml(todo.file)}:${todo.line}:${todo.column}</strong><p>${escapeHtml(todo.reason)}</p></div>
      </article>`),
		`<article class="evidence-row zero-row"><span class="count-badge">${unsupportedModules.length}</span><div><strong>Unsupported modules</strong><p>${unsupportedModules.length === 0 ? "None reported by the CLI." : "Every unsupported module is listed below."}</p></div></article>`,
		...unsupportedModules.map((module) => `<article class="evidence-row">
        <span class="count-badge">${module.count}</span>
        <div><strong><code>${escapeHtml(module.modulePath)}</code></strong><p>${escapeHtml(module.usageStyle)}</p></div>
      </article>`)
	];
	getElement(selector).innerHTML = rows.join("");
}
function renderMappings(selector, mappings) {
	getElement(selector).innerHTML = `
    <table>
      <thead><tr><th scope="col">Kind</th><th scope="col">Total</th><th scope="col">Auto</th><th scope="col">Manual</th></tr></thead>
      <tbody>${mappings.map((mapping) => `<tr data-zero="${mapping.total === 0}">
            <th scope="row"><code>${escapeHtml(mapping.kind)}</code></th>
            <td>${mapping.total}</td><td>${mapping.autoMigrated}</td><td>${mapping.manual}</td>
          </tr>`).join("")}</tbody>
    </table>`;
}
function metric(id, label, value, tone, scope) {
	return {
		id,
		label,
		value,
		tone,
		scope
	};
}
function guideHref(path) {
	return `https://github.com/honua-io/honua-sdk-js/blob/trunk/${path}`;
}
function fact(label, value) {
	return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}
function passFail(value) {
	return value ? "Passed" : "Failed";
}
function formatJson(value) {
	return value === void 0 ? "missing" : JSON.stringify(value);
}
function setText(selector, value) {
	getElement(selector).textContent = value;
}
function getElement(selector) {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`Missing required element: ${selector}`);
	return element;
}
function escapeHtml(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
//#endregion
