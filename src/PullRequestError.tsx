import { apiUrl } from "./api/client";
import * as Repositories from "./repositoriesSlice";

const PullRequestsError = ({ error }: { error: Repositories.PullRequestsError }) => {
  switch (error) {
    case "authorizationRequired":
      return (
        <p className="repo-pr-status">
          GitHub App authorization required.{" "}
          <a href={apiUrl("/api/github-app/authorize")}>Authorize more repos</a>.
        </p>
      );
    case "repositoryNotTracked":
      return <p className="repo-pr-status">Repository is not tracked.</p>;
    case "pullRequestNotFound":
      return <p className="repo-pr-status">Pull request is not stored yet.</p>;
    case "syncFailed":
      return <p className="repo-pr-status">Pull requests could not be synced.</p>;
  }
};

export default PullRequestsError;
