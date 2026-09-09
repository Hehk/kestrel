import * as stylex from "@stylexjs/stylex";
import { apiUrl } from "./api/client";
import { Anchor } from "./components/Anchor";
import * as Repositories from "./repositoriesSlice";
import { styles as baseStyles } from "./styles/base";

const statusAttributes = stylex.attrs(baseStyles.statusText);

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
