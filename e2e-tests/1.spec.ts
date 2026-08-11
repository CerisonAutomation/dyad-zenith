import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";

test(
  "renders the first page without a router invariant crash",
  async ({ electronApp }) => {
    const page = await electronApp.firstWindow();

    await expect(
      page.getByRole("heading", { name: "What do you want to build?" }),
    ).toBeVisible();

    await expect(
      page.getByText(/Could not find an active match from "\/chat"/i),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Sorry, that shouldn't have happened!/i),
    ).toHaveCount(0);
  },
);
