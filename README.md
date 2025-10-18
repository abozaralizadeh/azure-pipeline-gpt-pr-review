# Advanced Azure DevOps PR Reviewer

An intelligent, AI-powered Pull Request reviewer for Azure DevOps that uses Azure OpenAI and LangGraph React agent to provide precise, contextual code reviews.

## 🚀 Features

### 🤖 Advanced AI-Powered Review
- **LangGraph React Agent**: Uses sophisticated reasoning chains to analyze code systematically
- **Azure OpenAI Integration**: Leverages state-of-the-art language models for accurate code analysis
- **Context-Aware Review**: Understands PR context and only writes reviews when necessary
- **Maximum 100 LLM Calls**: Efficient resource usage with configurable limits

### 🔍 Comprehensive Code Analysis
- **Code Quality Review**: Identifies bugs, performance issues, and maintainability concerns
- **Security Scanning**: Detects vulnerabilities like SQL injection, XSS, hardcoded secrets
- **Style & Standards**: Ensures adherence to coding standards and best practices
- **Test Coverage**: Analyzes test adequacy and suggests improvements

### 🛠️ Azure DevOps Integration
- **Inline Comments**: Posts specific feedback directly on code lines
- **File-Level Comments**: Provides comprehensive file overviews
- **PR Summary**: Generates detailed review summaries with actionable recommendations
- **Smart Filtering**: Skips binary files and focuses on reviewable code

### 📊 Intelligent Decision Making
- **Context Analysis**: Determines if detailed review is needed based on PR scope
- **Confidence Scoring**: Only suggests changes above configurable confidence thresholds
- **Actionable Feedback**: Provides specific code suggestions and improvements
- **Review Recommendations**: Suggests approve, approve with suggestions, or request changes

## 🏗️ Architecture

The extension uses a sophisticated LangGraph-based architecture:

```
PR Context → Context Analysis → File Review → Security Scan → Code Suggestions → Final Assessment
     ↓              ↓              ↓           ↓              ↓              ↓
  Determine      Review Each    Security    Generate      Post Results   Task Result
  Review Need    File          Analysis    Suggestions    to Azure      & Summary
```

### Core Components

1. **Review Orchestrator**: Coordinates the entire review process
2. **LangGraph Agent**: Manages the reasoning flow and LLM interactions
3. **Azure DevOps Service**: Handles all Azure DevOps API interactions
4. **Review State Management**: Tracks review progress and maintains context

## 📋 Prerequisites

### Azure OpenAI Setup
1. **Azure OpenAI Resource**: Create an Azure OpenAI resource in your Azure subscription
2. **Model Deployment**: Deploy a GPT-4 or GPT-3.5-turbo model
3. **API Access**: Ensure your Azure DevOps pipeline has access to the Azure OpenAI endpoint

### Azure DevOps Configuration
1. **Build Service Permissions**: The build service needs permissions to:
   - Read repository content
   - Create and manage PR comments
   - Access PR details and changes

2. **Pipeline Variables**: Configure the following variables:
   - `azure_openai_endpoint`: Your Azure OpenAI endpoint URL
   - `azure_openai_api_key`: Your Azure OpenAI API key
   - `azure_openai_deployment_name`: Your model deployment name

## 🚀 Installation

### 1. Install the Extension
- Download the extension from the Azure DevOps marketplace
- Install it in your Azure DevOps organization

### 2. Add to Pipeline
Add the task to your Azure DevOps pipeline YAML:

```yaml
- task: GENAIADVANCEDPRREVIEWER@2
  inputs:
    azure_openai_endpoint: 'https://your-resource.openai.azure.com/'
    azure_openai_api_key: '$(AZURE_OPENAI_API_KEY)'
    azure_openai_deployment_name: 'gpt-4'
    max_llm_calls: '100'
    review_threshold: '0.7'
    enable_code_suggestions: true
    enable_security_scanning: true
    support_self_signed_certificate: false
```

### 3. Configure Variables
Set up pipeline variables in Azure DevOps:

```yaml
variables:
  AZURE_OPENAI_API_KEY: $(AZURE_OPENAI_API_KEY)
```

## ⚙️ Configuration Options

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `azure_openai_endpoint` | string | ✅ | - | Azure OpenAI endpoint URL |
| `azure_openai_api_key` | string | ✅ | - | Azure OpenAI API key |
| `azure_openai_deployment_name` | string | ✅ | - | Model deployment name |
| `max_llm_calls` | string | ❌ | 100 | Maximum LLM calls allowed |
| `review_threshold` | string | ❌ | 0.7 | Confidence threshold for suggestions |
| `enable_code_suggestions` | boolean | ❌ | true | Enable AI code suggestions |
| `enable_security_scanning` | boolean | ❌ | true | Enable security vulnerability scanning |
| `support_self_signed_certificate` | boolean | ❌ | false | Support self-signed certificates |

## 🔧 How It Works

### 1. Context Analysis
The agent first analyzes the PR context to determine if a detailed review is necessary:
- PR title and description
- Changed files and scope
- Branch information
- Author and reviewer details

### 2. File-by-File Review
For each changed file, the agent:
- Retrieves file content and diff
- Performs comprehensive code analysis
- Identifies issues and improvements
- Generates specific suggestions

### 3. Security Analysis
When enabled, performs security scanning for:
- SQL injection vulnerabilities
- XSS and injection attacks
- Hardcoded secrets
- Insecure authentication patterns
- Input validation issues

### 4. Code Suggestions
Generates actionable improvements:
- Before/after code examples
- Performance optimizations
- Readability improvements
- Best practice recommendations

### 5. Final Assessment
Provides comprehensive review summary:
- Overall quality assessment
- Issue categorization and counts
- Approval recommendations
- Actionable next steps

## 📊 Review Output

### Comment Types
- **🐛 Bug**: Logic errors and functional issues
- **🔒 Security**: Security vulnerabilities and concerns
- **💡 Improvement**: Code quality and maintainability suggestions
- **🎨 Style**: Coding standards and formatting issues
- **🧪 Test**: Test coverage and testing recommendations

### Review Summary
The extension posts a comprehensive summary comment including:
- Overall assessment (approve/approve with suggestions/request changes)
- Statistics on issues found by category
- Summary of key findings
- Specific recommendations for the PR author

## 🎯 Best Practices

### For Developers
1. **Clear PR Descriptions**: Provide context about what the PR accomplishes
2. **Focused Changes**: Keep PRs focused on single concerns
3. **Test Coverage**: Include tests for new functionality
4. **Code Standards**: Follow your team's coding standards

### For Pipeline Administrators
1. **Resource Management**: Set appropriate `max_llm_calls` based on your needs
2. **Threshold Tuning**: Adjust `review_threshold` based on team preferences
3. **Security Scanning**: Enable security scanning for production code
4. **Monitoring**: Monitor LLM usage and costs

### For Teams
1. **Review Culture**: Use the extension as a learning tool, not just a gate
2. **Feedback Integration**: Incorporate AI suggestions into team coding standards
3. **Continuous Improvement**: Regularly review and adjust configuration
4. **Knowledge Sharing**: Use AI insights to improve team coding practices

## 🔍 Troubleshooting

### Common Issues

#### Authentication Errors
- Verify Azure OpenAI API key is correct
- Ensure the key has access to the specified deployment
- Check if the key has expired

#### Permission Errors
- Verify build service has repository read access
- Ensure build service can create PR comments
- Check organization-level permissions

#### High LLM Usage
- Reduce `max_llm_calls` if hitting limits
- Adjust `review_threshold` to filter out low-confidence suggestions
- Consider disabling code suggestions for large PRs

#### Performance Issues
- Monitor Azure OpenAI service performance
- Check network connectivity to Azure OpenAI
- Consider using smaller models for faster responses

### Debug Information
The extension provides detailed logging:
- Configuration validation
- File processing progress
- LLM call tracking
- Error details and stack traces

### Verbose logging
You can enable verbose debug logs (shows LLM prompts and response previews) by setting the environment variable `ADVPR_VERBOSE=1`. The task manifest sets this by default for the packaged task, but you can override it in your pipeline or agent environment if you prefer quieter logs.

## 📈 Performance & Cost

### LLM Call Optimization
- **Context Analysis**: 1-2 calls per PR
- **File Review**: 3-5 calls per file (depending on complexity)
- **Security Scan**: 1-2 calls per file
- **Code Suggestions**: 1-2 calls per file with issues
- **Final Assessment**: 1 call per PR

### Cost Considerations
- Monitor Azure OpenAI usage and costs
- Adjust `max_llm_calls` based on budget constraints
- Use appropriate model tiers for your needs
- Consider batch processing for large repositories

## 🔮 Future Enhancements

### Planned Features
- **Custom Review Templates**: Team-specific review criteria
- **Integration with SonarQube**: Combined static and AI analysis
- **Multi-Language Support**: Enhanced support for various programming languages
- **Review History**: Track review quality and improvement over time
- **Team Learning**: Share insights across team members

### Extensibility
- **Plugin Architecture**: Support for custom review modules
- **API Integration**: Webhook support for external tools
- **Custom Models**: Support for fine-tuned models
- **Review Workflows**: Configurable review processes

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run tests: `npm test`

### Code Standards
- Follow TypeScript best practices
- Include comprehensive error handling
- Add unit tests for new features
- Update documentation for changes

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Azure OpenAI Team**: For providing the underlying AI capabilities
- **LangGraph Community**: For the excellent graph-based reasoning framework
- **Azure DevOps Team**: For the robust platform and APIs
- **Open Source Contributors**: For the various libraries and tools used

## 📞 Support

- **Issues**: Report bugs and feature requests on GitHub
- **Documentation**: Check this README and inline code comments
- **Community**: Join our discussions and share experiences
- **Enterprise**: Contact us for enterprise support and customization

---

**Made with ❤️ for the Azure DevOps community**
