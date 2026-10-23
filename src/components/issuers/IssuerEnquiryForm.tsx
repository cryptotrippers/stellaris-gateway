import { useState, type FormEvent } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ASSET_CATEGORIES, issuerLeadSchema } from "./lead-schema";
import { submitIssuerLead } from "./leads.functions";

export function IssuerEnquiryForm() {
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = issuerLeadSchema.safeParse({
      ...Object.fromEntries(values),
      consent: values.get("consent") === "on",
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check your details.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await submitIssuerLead({ data: parsed.data });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your enquiry could not be saved.");
    } finally {
      setPending(false);
    }
  }
  if (saved)
    return (
      <div role="status" className="border-l-2 border-teal py-6 pl-6">
        <CheckCircle2 className="h-8 w-8 text-teal" />
        <h3 className="mt-4 text-xl font-semibold">Your enquiry has been received.</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This is an initial enquiry, not a listing, verification or funding approval.
        </p>
        <Button variant="outline" className="mt-6" onClick={() => setSaved(false)}>
          Send another enquiry
        </Button>
      </div>
    );
  return (
    <form onSubmit={submit} className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        {[
          ["contact_name", "Your name", "text", 100, "name"],
          ["email", "Work email", "email", 254, "email"],
          ["organization", "Organisation / legal entity", "text", 160, "organization"],
          ["jurisdiction", "Project jurisdiction", "text", 100, "country-name"],
        ].map(([name, label, type, max, autocomplete]) => (
          <div key={name} className="space-y-2">
            <Label htmlFor={String(name)}>{label}</Label>
            <Input
              id={String(name)}
              name={String(name)}
              type={String(type)}
              maxLength={Number(max)}
              autoComplete={String(autocomplete)}
              required
            />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Label htmlFor="asset_category">Asset category</Label>
        <select
          id="asset_category"
          name="asset_category"
          required
          defaultValue=""
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="" disabled>
            Select a category
          </option>
          {ASSET_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="project_summary">Project overview</Label>
        <Textarea
          id="project_summary"
          name="project_summary"
          required
          minLength={20}
          maxLength={3000}
          rows={5}
          placeholder="Asset, location, legal structure, current stage and what you want to explore."
        />
        <p className="text-xs text-muted-foreground">
          Do not include identity documents, bank details or confidential evidence.
        </p>
      </div>
      <div className="hidden" aria-hidden="true">
        <input name="website_check" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <label className="flex items-start gap-3 text-sm text-muted-foreground">
        <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 accent-teal" />I
        agree that Stellaris may store these details and contact me about this project enquiry.
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="justify-self-start" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}{" "}
        {pending ? "Submitting…" : "Submit enquiry"}
      </Button>
    </form>
  );
}
