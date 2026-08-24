#!/usr/bin/env bun
import { main } from "../src/cli/main.ts";
await main(Bun.argv.slice(2));
