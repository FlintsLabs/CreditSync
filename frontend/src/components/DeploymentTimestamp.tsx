import { useEffect, useState } from "react";
import { formatDeploymentTimestamp, parseDeploymentMetadata } from "../lib/deployment";

type DeploymentTimestampProps = {
    language: string;
    label: string;
    unavailableLabel: string;
};

export default function DeploymentTimestamp({ language, label, unavailableLabel }: DeploymentTimestampProps) {
    const [timestamp, setTimestamp] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let active = true;
        void fetch("/deployment.json", { cache: "no-store" })
            .then((response) => response.ok ? response.json() : null)
            .then((metadata) => {
                if (active) {
                    setTimestamp(parseDeploymentMetadata(metadata)?.timestamp ?? null);
                    setLoaded(true);
                }
            })
            .catch(() => {
                if (active) {
                    setTimestamp(null);
                    setLoaded(true);
                }
            });
        return () => { active = false; };
    }, []);

    if (!loaded) return null;
    if (!timestamp) return <span data-testid="deployment-timestamp-unavailable">{unavailableLabel}</span>;

    return (
        <span>
            {label} <time data-testid="deployment-timestamp" dateTime={timestamp}>{formatDeploymentTimestamp(timestamp, language)}</time>
        </span>
    );
}
