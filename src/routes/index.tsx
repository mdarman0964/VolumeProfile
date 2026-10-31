import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@/components/desk/terminal";

export const Route = createFileRoute("/")({
  component: Terminal,
});
