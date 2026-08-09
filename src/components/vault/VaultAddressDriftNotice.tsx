import { AlertTriangle } from "lucide-react";
import { cardanoscanAddress, short } from "@/lib/chain-format";

/**
 * Shown whenever the stored vault address no longer matches the address this
 * build's validators derive. The live address is always the one displayed; the
 * superseded one is kept visible only as a link for fund recovery.
 */
export function VaultAddressDriftNotice({
  registryAddress,
  derivedAddress,
}: {
  registryAddress: string;
  derivedAddress: string;
}) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="space-y-1">
        <p className="font-medium">
          The registered address is out of date — the vault must be re-bootstrapped.
        </p>
        <p className="text-muted-foreground">
          Current script derives{" "}
          <a
            href={cardanoscanAddress(derivedAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-primary"
          >
            {short(derivedAddress, 12, 8)}
          </a>
          ; the registry still points at{" "}
          <a
            href={cardanoscanAddress(registryAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono"
          >
            {short(registryAddress, 12, 8)}
          </a>
          .
        </p>
      </div>
    </div>
  );
}
