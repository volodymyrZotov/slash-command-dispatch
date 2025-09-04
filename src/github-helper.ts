import * as core from '@actions/core'
import {Octokit, PullsGetResponseData} from './octokit-client'
import {Command, SlashCommandPayload} from './command-helper'
import {inspect} from 'util'
import * as utils from './utils'

type ReposCreateDispatchEventParamsClientPayload = {
  [key: string]: ReposCreateDispatchEventParamsClientPayloadKeyString
}
// eslint-disable-next-line
type ReposCreateDispatchEventParamsClientPayloadKeyString = {}

export interface ClientPayload
  extends ReposCreateDispatchEventParamsClientPayload {
  // eslint-disable-next-line
  github: any
  // eslint-disable-next-line
  pull_request?: any
  // eslint-disable-next-line
  slash_command?: SlashCommandPayload | any
}

interface Repository {
  owner: string
  repo: string
}

type CollaboratorPermission = {
  repository: {
    collaborators: {
      edges: [
        {
          permission: string
        }
      ]
    }
  }
}

export class GitHubHelper {
  private octokit: InstanceType<typeof Octokit>

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      baseUrl: process.env['GITHUB_API_URL'] || 'https://api.github.com'
    })
  }

  private parseRepository(repository: string): Repository {
    const [owner, repo] = repository.split('/')
    return {
      owner: owner,
      repo: repo
    }
  }

  async getActorPermission(repo: Repository, actor: string): Promise<string> {
    // First, check for direct collaborator permissions
    const directPermission = await this.getDirectCollaboratorPermission(
      repo,
      actor
    )
    if (directPermission !== 'none') {
      return directPermission
    }

    // If no direct permission, check team-based permissions
    return await this.getTeamBasedPermission(repo, actor)
  }

  private async getDirectCollaboratorPermission(
    repo: Repository,
    actor: string
  ): Promise<string> {
    core.debug(`Checking direct permissions`)
    // https://docs.github.com/en/graphql/reference/enums#repositorypermission
    // https://docs.github.com/en/graphql/reference/objects#repositorycollaboratoredge
    // Returns 'READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'
    const query = `query CollaboratorPermission($owner: String!, $repo: String!, $collaborator: String) {
      repository(owner:$owner, name:$repo) {
        collaborators(login: $collaborator) {
          edges {
            permission
          }
        }
      }
    }`
    const collaboratorPermission =
      await this.octokit.graphql<CollaboratorPermission>(query, {
        ...repo,
        collaborator: actor
      })
    core.debug(
      `Direct CollaboratorPermission: ${inspect(
        collaboratorPermission.repository.collaborators.edges
      )}`
    )
    return collaboratorPermission.repository.collaborators.edges.length > 0
      ? collaboratorPermission.repository.collaborators.edges[0].permission.toLowerCase()
      : 'none'
  }

  private async getTeamBasedPermission(
    repo: Repository,
    actor: string
  ): Promise<string> {
    core.debug(`Checking team-based permissions`)
    try {
      // Check if this is an organization repository
      const {data: repository} = await this.octokit.rest.repos.get({
        ...repo
      })

      if (!repository.owner.type || repository.owner.type !== 'Organization') {
        core.debug(
          'Repository is not owned by an organization, skipping team permission check'
        )
        return 'none'
      }

      core.debug(`Checking team permissions for user ${actor} using REST API`)

      // Get all teams in the organization
      const {data: allTeams} = await this.octokit.rest.teams.list({
        org: repository.owner.login
      })

      core.debug(`Found ${allTeams.length} teams in organization`)

      let highestPermission = 'none'
      const permissionLevels = ['read', 'triage', 'write', 'maintain', 'admin']

      // Check each team for user membership and repository access
      for (const team of allTeams) {
        try {
          // Check if the user is a member of this team
          await this.octokit.rest.teams.getMembershipForUserInOrg({
            org: repository.owner.login,
            team_slug: team.slug,
            username: actor
          })

          core.debug(`User ${actor} is member of team ${team.name}`)

          // Check if team has access to the repository
          await this.octokit.rest.teams.checkPermissionsForRepoInOrg({
            org: repository.owner.login,
            team_slug: team.slug,
            owner: repo.owner,
            repo: repo.repo
          })

          core.debug(`Team ${team.name} has access to repository`)

          // Get the team's repositories to find the permission level
          const {data: teamRepos} =
            await this.octokit.rest.teams.listReposInOrg({
              org: repository.owner.login,
              team_slug: team.slug
            })

          const teamRepo = teamRepos.find(
            teamRepo =>
              teamRepo.name === repo.repo && teamRepo.owner.login === repo.owner
          )

          if (teamRepo && teamRepo.permissions) {
            // Determine permission level
            let teamPermission = 'none'
            if (teamRepo.permissions.admin) {
              teamPermission = 'admin'
            } else if (teamRepo.permissions.maintain) {
              teamPermission = 'maintain'
            } else if (teamRepo.permissions.push) {
              teamPermission = 'write'
            } else if (teamRepo.permissions.triage) {
              teamPermission = 'triage'
            } else if (teamRepo.permissions.pull) {
              teamPermission = 'read'
            }

            core.debug(
              `User ${actor} has ${teamPermission} permission via team ${team.name}`
            )

            // Keep the highest permission level
            const teamPermissionLevel = permissionLevels.indexOf(teamPermission)
            const highestPermissionLevel =
              permissionLevels.indexOf(highestPermission)
            if (teamPermissionLevel > highestPermissionLevel) {
              highestPermission = teamPermission
            }
          } else {
            core.debug(
              `Team ${team.name} has access but no permission details found`
            )
            // If team has access but we can't determine exact permission, default to read
            const readLevel = permissionLevels.indexOf('read')
            const highestLevel = permissionLevels.indexOf(highestPermission)
            if (readLevel > highestLevel) {
              highestPermission = 'read'
            }
          }
        } catch (membershipError) {
          // User is not a member of this team
          core.debug(`User ${actor} is not a member of team ${team.name}`)
        }
      }

      core.debug(`Team-based permission for ${actor}: ${highestPermission}`)
      return highestPermission
    } catch (error) {
      core.debug(
        `Error checking team permissions: ${utils.getErrorMessage(error)}`
      )
      return 'none'
    }
  }

  async tryAddReaction(
    repo: Repository,
    commentId: number,
    reaction:
      | '+1'
      | '-1'
      | 'laugh'
      | 'confused'
      | 'heart'
      | 'hooray'
      | 'rocket'
      | 'eyes'
  ): Promise<void> {
    try {
      await this.octokit.rest.reactions.createForIssueComment({
        ...repo,
        comment_id: commentId,
        content: reaction
      })
    } catch (error) {
      core.debug(utils.getErrorMessage(error))
      core.warning(`Failed to set reaction on comment ID ${commentId}.`)
    }
  }

  async getPull(
    repo: Repository,
    pullNumber: number
  ): Promise<PullsGetResponseData> {
    const {data: pullRequest} = await this.octokit.rest.pulls.get({
      ...repo,
      pull_number: pullNumber
    })
    return pullRequest
  }

  async createDispatch(
    cmd: Command,
    clientPayload: ClientPayload
  ): Promise<void> {
    if (cmd.dispatch_type == 'repository') {
      await this.createRepositoryDispatch(cmd, clientPayload)
    } else {
      await this.createWorkflowDispatch(cmd, clientPayload)
    }
  }

  private async createRepositoryDispatch(
    cmd: Command,
    clientPayload: ClientPayload
  ): Promise<void> {
    const eventType = `${cmd.command}${cmd.event_type_suffix}`
    await this.octokit.rest.repos.createDispatchEvent({
      ...this.parseRepository(cmd.repository),
      event_type: `${cmd.command}${cmd.event_type_suffix}`,
      client_payload: clientPayload
    })
    core.info(
      `Command '${cmd.command}' dispatched to '${cmd.repository}' ` +
        `with event type '${eventType}'.`
    )
  }

  async createWorkflowDispatch(
    cmd: Command,
    clientPayload: ClientPayload
  ): Promise<void> {
    const workflow = `${cmd.command}${cmd.event_type_suffix}.yml`
    const slashCommand: SlashCommandPayload = clientPayload.slash_command
    const ref = slashCommand.args.named.ref
      ? slashCommand.args.named.ref
      : await this.getDefaultBranch(cmd.repository)

    // Take max 10 named arguments, excluding 'ref'.
    const inputs = {}
    let count = 0
    for (const key in slashCommand.args.named) {
      if (key != 'ref') {
        inputs[key] = slashCommand.args.named[key]
        count++
      }
      if (count == 10) break
    }

    await this.octokit.request(
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
      {
        ...this.parseRepository(cmd.repository),
        workflow_id: workflow,
        ref: ref,
        inputs: inputs
      }
    )
    core.info(
      `Command '${cmd.command}' dispatched to workflow '${workflow}' in '${cmd.repository}'`
    )
  }

  private async getDefaultBranch(repository: string): Promise<string> {
    const {data: repo} = await this.octokit.rest.repos.get({
      ...this.parseRepository(repository)
    })
    return repo.default_branch
  }
}
