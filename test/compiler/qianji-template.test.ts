import { describe, expect, it } from "vitest";
import { loadQianjiTemplates } from "../../src/compiler/qianji-template.js";

describe("loadQianjiTemplates", () => {
	it("loads only BPMN template for BPMN target", async () => {
		const requested: string[] = [];
		const result = await loadQianjiTemplates("bpmn", {
			cwd: process.cwd(),
			runner: async (domain) => {
				requested.push(domain);
				return { success: true, template: `<${domain}/>` };
			},
		});

		expect(result.success).toBe(true);
		expect(requested).toEqual(["bpmn"]);
		if (result.success) {
			expect(result.templates.bpmn).toBe("<bpmn/>");
			expect(result.templates.dmn).toBeUndefined();
		}
	});

	it("loads BPMN and DMN templates for BPMN+DMN target", async () => {
		const requested: string[] = [];
		const result = await loadQianjiTemplates("bpmn-dmn", {
			cwd: process.cwd(),
			runner: async (domain) => {
				requested.push(domain);
				return { success: true, template: `<${domain}/>` };
			},
		});

		expect(result.success).toBe(true);
		expect(requested).toEqual(["bpmn", "dmn"]);
		if (result.success) {
			expect(result.templates.bpmn).toBe("<bpmn/>");
			expect(result.templates.dmn).toBe("<dmn/>");
		}
	});

	it("returns qianji template errors", async () => {
		const result = await loadQianjiTemplates("bpmn", {
			cwd: process.cwd(),
			runner: async () => ({ success: false, errors: ["qianji template failed"] }),
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errors).toEqual(["qianji template failed"]);
		}
	});
});
