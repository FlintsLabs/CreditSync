import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../lib/i18n";
import { PaymentBatchEditor } from "./PaymentBatchEditor";

test("renders the localized atomic batch editor", () => {
    render(<I18nextProvider i18n={i18n}><PaymentBatchEditor onPreview={() => undefined} onExecute={() => undefined} /></I18nextProvider>);
    expect(screen.getByTestId("payment-batch-editor")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /atomic payment batch/i })).toBeTruthy();
});
