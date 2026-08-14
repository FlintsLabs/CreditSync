import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
await import("@testing-library/jest-dom");
