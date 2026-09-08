import * as stylex from "@stylexjs/stylex";
import { apiUrl } from "./api/client";
import { Anchor } from "./components/Anchor";
import { tokens } from "./styles/tokens.stylex";
import * as Repositories from "./repositoriesSlice";
import { styles as baseStyles } from "./styles/base";

const styles = stylex.create({
  status: {
    margin: 0,
    color: tokens.textMuted,
    fontSize: "0.92rem",
  },
});

const statusAttributes = stylex.attrs(baseStyles.paragraph, styles.status);

const PullRequestsError = ({ error }: { error: Repositories.PullRequestsError }) => {
  switch (error) {
    case "authorizationRequired":
      return (
        <p {...statusAttributes}>
          GitHub App authorization required.{" "}
          <Anchor href={apiUrl("/api/github-app/authorize")}>Authorize more repos</Anchor>.
        </p>
      );
    case "repositoryNotTracked":
      return <p {...statusAttributes}>Repository is not tracked.</p>;
    case "pullRequestNotFound":
      return <p {...statusAttributes}>Pull request is not stored yet.</p>;
    case "syncFailed":
      return <p {...statusAttributes}>Pull requests could not be synced.</p>;
  }
};

export default PullRequestsError;
