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

type TeamPermission = {
  repository: {
    teams: {
      nodes: [
        {
          name: string
          slug: string
          repositories: {
            nodes: [
              {
                name: string
                permissions: {
                  admin: boolean
                  maintain: boolean
                  push: boolean
                  triage: boolean
                  pull: boolean
                }
              }
            ]
          }
          members: {
            nodes: [
              {
                login: string
              }
            ]
          }
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

      core.debug(`Checking team permissions for user ${actor} using GraphQL`)

      // Use GraphQL to get all teams and their permissions in a single query
      const query = `query TeamPermissions($owner: String!, $repo: String!, $username: String!) {
        repository(owner: $owner, name: $repo) {
          teams(first: 100) {
            nodes {
              name
              slug
              repositories(first: 1, query: "${repo.owner}/${repo.repo}") {
                nodes {
                  name
                  permissions
                }
              }
              members(first: 100, query: $username) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }`

      const teamPermissions = await this.octokit.graphql<TeamPermission>(
        query,
        {
          owner: repo.owner,
          repo: repo.repo,
          username: actor
        }
      )

      let highestPermission = 'none'
      const permissionLevels = ['read', 'triage', 'write', 'maintain', 'admin']

      if (teamPermissions.repository?.teams?.nodes) {
        for (const team of teamPermissions.repository.teams.nodes) {
          // Check if the user is a member of this team
          const isMember = team.members?.nodes?.some(
            (member: any) => member.login === actor
          )

          if (isMember && team.repositories?.nodes?.length > 0) {
            const teamRepo = team.repositories.nodes[0]
            if (teamRepo.permissions) {
              // The GraphQL API returns permissions object with pull, push, admin, etc.
              // We need to determine the highest permission level
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
              const teamPermissionLevel =
                permissionLevels.indexOf(teamPermission)
              const highestPermissionLevel =
                permissionLevels.indexOf(highestPermission)
              if (teamPermissionLevel > highestPermissionLevel) {
                highestPermission = teamPermission
              }
            }
          }
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
