import { describe, expect, it } from "vitest";

import { CompatEventBus, FeatureFormCompat } from "../src/index.js";

describe("FeatureFormCompat", () => {
  it("supports when() and watch() for lifecycle state", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const form = new FeatureFormCompat({ eventBus });
    const loadStatusValues: unknown[] = [];
    const loadedValues: unknown[] = [];
    const loadStatusHandle = form.watch("loadStatus", (value) => {
      loadStatusValues.push(value);
    });
    const loadedHandle = form.watch("loaded", (value) => {
      loadedValues.push(value);
    });

    let callbackForm: FeatureFormCompat | undefined;
    const resolved = await form.when((widget) => {
      callbackForm = widget;
    });

    loadStatusHandle.remove();
    loadedHandle.remove();
    const watchSnapshot = {
      loadStatus: loadStatusValues.length,
      loaded: loadedValues.length,
    };

    await form.load();

    expect(resolved).toBe(form);
    expect(callbackForm).toBe(form);
    expect(form.loaded).toBe(true);
    expect(form.loadStatus).toBe("loaded");
    expect(loadStatusValues).toEqual(["loading", "loaded"]);
    expect(loadedValues).toEqual([true]);
    expect(seenTypes).toContain("feature-form.loading");
    expect(seenTypes).toContain("feature-form.loaded");
    expect(loadStatusValues).toHaveLength(watchSnapshot.loadStatus);
    expect(loadedValues).toHaveLength(watchSnapshot.loaded);
  });

  it("updates feature state and submits values", async () => {
    const form = new FeatureFormCompat({
      feature: { attributes: { OBJECTID: 1, status: "Open" } },
      fieldConfig: [{ name: "status" }],
      groupDisplay: "all",
      headingLevel: 3,
      visibleElements: { description: true },
    });

    form.setFeature({ attributes: { OBJECTID: 2, status: "Closed" } });
    const result = await form.submit({ status: "Closed" });

    expect(result.valid).toBe(true);
    expect(result.values).toMatchObject({ status: "Closed" });
    expect(result.feature).toMatchObject({ attributes: { OBJECTID: 2 } });
    expect(form.groupDisplay).toBe("all");
    expect(form.headingLevel).toBe(3);
    expect(form.visibleElements).toEqual({ description: true });
  });

  it("emits feature change and submit events", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    const features: unknown[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const form = new FeatureFormCompat({ eventBus });
    const featureHandle = form.watch("feature", (value) => {
      features.push(value);
    });
    form.setFeature({ attributes: { OBJECTID: 10 } });
    await form.submit({ name: "Parcel 10" });
    featureHandle.remove();
    const watchSnapshot = {
      features: features.length,
    };

    form.setFeature({ attributes: { OBJECTID: 11 } });

    expect(seenTypes).toContain("feature-form.feature-changed");
    expect(seenTypes).toContain("feature-form.submitted");
    expect(features).toEqual([{ attributes: { OBJECTID: 10 } }]);
    expect(features).toHaveLength(watchSnapshot.features);
  });

  it("runs validation function and returns errors on submit", async () => {
    const form = new FeatureFormCompat({
      validationFunction: (fieldName, value) => {
        if (fieldName === "name" && (value === undefined || value === "")) {
          return { fieldName: "name", errorMessage: "Name is required", type: "required" };
        }
        return undefined;
      },
    });

    const result = await form.submit({ name: "", status: "active" });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]).toMatchObject({
      fieldName: "name",
      errorMessage: "Name is required",
      type: "required",
    });

    const validResult = await form.submit({ name: "Parcel A", status: "active" });
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toBeUndefined();
  });

  it("validate() can be called independently", () => {
    const form = new FeatureFormCompat({
      validationFunction: (fieldName, value) => {
        if (fieldName === "age" && typeof value === "number" && value < 0) {
          return { fieldName: "age", errorMessage: "Age must be positive", type: "range" };
        }
        return undefined;
      },
    });

    const errors = form.validate({ age: -1, name: "Test" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ fieldName: "age", type: "range" });

    const noErrors = form.validate({ age: 25, name: "Test" });
    expect(noErrors).toHaveLength(0);
  });

  it("validate() returns empty array when no validation function is set", () => {
    const form = new FeatureFormCompat();
    const errors = form.validate({ name: "" });
    expect(errors).toHaveLength(0);
  });

  it("emits validation-error event when validation fails on submit", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const form = new FeatureFormCompat({
      eventBus,
      validationFunction: (fieldName) => {
        if (fieldName === "required_field") {
          return { fieldName: "required_field", errorMessage: "Required", type: "required" };
        }
        return undefined;
      },
    });

    await form.submit({ required_field: "anything" });

    expect(seenTypes).toContain("feature-form.validation-error");
    expect(seenTypes).toContain("feature-form.submitted");
  });

  it("getValues() merges feature attributes with overrides", () => {
    const form = new FeatureFormCompat({
      feature: { attributes: { OBJECTID: 1, name: "Original", status: "open" } },
    });

    const values = form.getValues({ name: "Updated" });
    expect(values).toEqual({ OBJECTID: 1, name: "Updated", status: "open" });
  });

  it("getValues() returns empty object when no feature is set", () => {
    const form = new FeatureFormCompat();
    const values = form.getValues({ name: "Test" });
    expect(values).toEqual({ name: "Test" });
  });

  it("on() subscribes to namespaced events and handle.remove() stops delivery", async () => {
    const eventBus = new CompatEventBus();
    const form = new FeatureFormCompat({ eventBus });

    const received: unknown[] = [];
    const handle = form.on("submitted", (event) => {
      received.push(event);
    });

    await form.submit({ name: "Test" });
    expect(received).toHaveLength(1);

    handle.remove();
    await form.submit({ name: "Test2" });
    expect(received).toHaveLength(1);
  });
});
