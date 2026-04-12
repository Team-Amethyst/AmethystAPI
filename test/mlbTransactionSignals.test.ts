import { describe, expect, it } from "vitest";
import { classifyMlbTransaction } from "../src/lib/mlbTransactionSignals";
import fixture from "../test-fixtures/mlb-api/transactions.sample.json";

describe("classifyMlbTransaction", () => {
  it("maps SC + injured list in description to injury (live API pattern)", () => {
    const tx = fixture.transactions.find((t) => t.typeCode === "SC");
    expect(tx).toBeDefined();
    const r = classifyMlbTransaction(
      tx!.typeCode!,
      tx!.typeDesc!,
      tx!.description
    );
    expect(r).toEqual({ type: "injury", severity: "low" });
  });

  it("15-day IL in description is medium severity (between 10-day low and 60-day high)", () => {
    const tx = fixture.transactions.find((t) => t.description?.includes("15-day"));
    expect(tx).toBeDefined();
    const r = classifyMlbTransaction(
      tx!.typeCode!,
      tx!.typeDesc!,
      tx!.description
    );
    expect(r).toEqual({ type: "injury", severity: "medium" });
  });

  it("DES / DFA is demotion", () => {
    const tx = fixture.transactions.find((t) => t.typeCode === "DES");
    expect(tx).toBeDefined();
    const r = classifyMlbTransaction(
      tx!.typeCode!,
      tx!.typeDesc!,
      tx!.description
    );
    expect(r).toEqual({ type: "demotion", severity: "medium" });
  });

  it("TR + Traded typeDesc is trade", () => {
    const tx = fixture.transactions.find((t) => t.typeCode === "TR");
    expect(tx).toBeDefined();
    const r = classifyMlbTransaction(
      tx!.typeCode!,
      tx!.typeDesc!,
      tx!.description
    );
    expect(r).toEqual({ type: "trade", severity: "medium" });
  });

  it("60-day IL in description is high severity", () => {
    expect(
      classifyMlbTransaction(
        "SC",
        "Status Change",
        "Team placed P Example on the 60-day injured list. Tommy John surgery."
      )
    ).toEqual({ type: "injury", severity: "high" });
  });

  it("returns null for unclassified codes", () => {
    expect(classifyMlbTransaction("XX", "Unknown", undefined)).toBeNull();
  });
});
