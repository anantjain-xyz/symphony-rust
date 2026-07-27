import { runValidationProfile } from "./check-validation-contract.mjs";

process.exitCode = runValidationProfile({ profileName: process.argv[2] });
